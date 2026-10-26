#!/usr/bin/env bash
#
# Get a fresh Namespace devbox's screen into the panel, then run the sandbox.
#
# A devbox gives you a terminal and nothing else, and its Mac starts out in a
# state the panel cannot show: Screen Sharing wants a login nobody told you,
# and the console sits at the lock screen with the simulator behind it. Every
# step here is something you would otherwise have to click through, and none
# of them can be clicked through without first being able to see the screen.
#
# One password, DEVBOX_PASSWORD, is used for both the VNC password and the
# account's login. It defaults to 12345 because the devbox's own auth gate is
# the real lock on the door; set it to something else if that bothers you.
#
# Idempotent: every step sets a value rather than toggling one, so run it
# every time instead of `npm run sandbox`.

set -u

PASSWORD="${DEVBOX_PASSWORD:-${VNC_PASSWORD:-12345}}"
ME="$(id -un)"
KICKSTART=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart

step() { printf '  %-10s %s\n' "$1" "$2"; }

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This prepares a macOS devbox. Use \`npm run sandbox\` anywhere else." >&2
  exit 1
fi
if ! sudo -n true 2>/dev/null; then
  echo "Needs passwordless sudo, which a Namespace devbox has. Run \`npm run sandbox\` instead." >&2
  exit 1
fi

echo

# Screen Sharing, with a plain VNC password switched on. Apple's own auth
# needs the account's password, which a devbox does not give out; this one
# we choose. vnc.html skips Apple's auth when no VNC_USER is set.
#
# And always onto the CONSOLE. With nobody signed in at the Mac's own
# screen, macOS gives each VNC connection a session of its own instead —
# the login window says "this session is started by screen sharing, NOT
# changing console information". Signing in there signs in that session
# only; the connection drops as it switches, and the next one gets a new
# login window, for ever, while the console stays at root. Set before the
# restart below, which is what makes the agent read it.
sudo defaults write /Library/Preferences/com.apple.RemoteManagement VNCAlwaysStartOnConsole -bool true
if sudo "$KICKSTART" -activate -configure -access -on -privs -all -allowAccessFor -allUsers \
    -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw "$PASSWORD" \
    -restart -agent >/dev/null 2>&1; then
  step "vnc" "Screen Sharing on, VNC password set"
else
  step "vnc" "could not configure Screen Sharing — the screen may not embed"
fi

# The account's login password. Nobody knows the one the image shipped with,
# and without it neither the lock screen nor `sysadminctl -screenLock` can be
# got past. Root CANNOT simply overwrite it: the account holds a SecureToken,
# so even `sudo dscl -passwd` demands the old password — interactively, which
# hung this script on "Please enter user's old password". So: try the old
# passwords an image is likely to ship with, never read from the terminal,
# and carry on without one if none of them is it.
LOGIN_SET=""
for old in "$PASSWORD" "" "$ME"; do
  if sudo dscl . -passwd "/Users/$ME" "$old" "$PASSWORD" </dev/null >/dev/null 2>&1; then
    LOGIN_SET=1
    break
  fi
done
if [[ -n "$LOGIN_SET" ]]; then
  step "login" "$ME's password set"
else
  step "login" "could not set $ME's password (its old one is unknown)"
fi

# Sign in at the SCREEN. The terminal is a remote shell, not a desktop: the
# Mac's own display can sit at the login window while commands run here, and
# the Simulator has no desktop to open on until someone signs in there. So
# turn on automatic login for this account and restart the login window,
# which signs it in. Only when nobody is signed in at the screen (console
# owned by root) — restarting the login window under a live session would
# end it. FileVault disables automatic login, so say so instead.
if [[ -n "$LOGIN_SET" ]]; then
  sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$ME"
  # /etc/kcpassword: the password XORed with Apple's fixed key, padded to a
  # multiple of 12 bytes. It is how loginwindow reads an auto-login password.
  key=(125 137 82 35 210 188 221 234 163 185 31)
  bytes=()
  for ((i = 0; i < ${#PASSWORD}; i++)); do bytes+=("$(printf '%d' "'${PASSWORD:i:1}")"); done
  while (( ${#bytes[@]} % 12 )); do bytes+=(0); done
  hex=""
  for ((i = 0; i < ${#bytes[@]}; i++)); do hex+=$(printf '\\x%02x' $(( bytes[i] ^ key[i % 11] ))); done
  printf "$hex" | sudo tee /etc/kcpassword >/dev/null
  sudo chown root:wheel /etc/kcpassword
  sudo chmod 600 /etc/kcpassword

  if fdesetup status 2>/dev/null | grep -q "On"; then
    step "screen" "FileVault is on, so it cannot sign in by itself — sign in on the panel"
  elif [[ "$(stat -f %Su /dev/console)" == "root" ]]; then
    sudo killall loginwindow 2>/dev/null
    for _ in {1..20}; do
      [[ "$(stat -f %Su /dev/console)" == "$ME" ]] && break
      sleep 1
    done
    if [[ "$(stat -f %Su /dev/console)" == "$ME" ]]; then
      step "screen" "signed $ME in at the screen"
    else
      step "screen" "could not sign in at the screen — sign in on the panel with $PASSWORD"
    fi
  else
    step "screen" "$(stat -f %Su /dev/console) is signed in at the screen"
  fi
fi

# Stop it locking. Sleep and the screensaver are what bring the lock screen
# up, and they need no password to switch off; screenLock off, which stops
# waking from them asking, does.
sudo pmset -a displaysleep 0 sleep 0 disksleep 0 >/dev/null 2>&1
defaults -currentHost write com.apple.screensaver idleTime -int 0 2>/dev/null
if [[ -n "$LOGIN_SET" ]]; then
  # From this shell it fails with "MKBDeviceSetGracePeriod error -14": the
  # setting belongs to the signed-in desktop session, which this shell is
  # not part of. `launchctl asuser` runs it inside that session instead.
  if sudo launchctl asuser "$(id -u)" sysadminctl -screenLock off -password "$PASSWORD" </dev/null 2>&1 \
      | grep -q "error"; then
    step "lock" "sleep and screensaver off; could not switch the lock itself off,"
    step "" "so the panel shows the lock screen when it does lock"
  else
    step "lock" "screen lock, sleep and screensaver off"
  fi
else
  step "lock" "sleep and screensaver off, so it should not lock from here on"
fi

# Unlock it if it is already locked. Best-effort: typing into the lock screen
# goes through System Events, which needs the Accessibility permission the
# crop already relies on.
if ioreg -n Root -d1 -a 2>/dev/null | grep -A1 CGSSessionScreenIsLocked | grep -q '<true/>'; then
  caffeinate -u -t 2 </dev/null # wake the display so the password field is there
  osascript \
    -e 'on run argv' \
    -e 'tell application "System Events" to keystroke (item 1 of argv)' \
    -e 'tell application "System Events" to key code 36' \
    -e 'end run' "$PASSWORD" >/dev/null 2>&1
  sleep 2
  if ioreg -n Root -d1 -a 2>/dev/null | grep -A1 CGSSessionScreenIsLocked | grep -q '<true/>'; then
    if [[ -n "$LOGIN_SET" ]]; then
      step "unlock" "still locked — click into the panel's screen and type $PASSWORD"
    else
      step "unlock" "LOCKED, and $ME's password is unknown, so it cannot be"
      step "" "unlocked from here. Start a fresh devbox and run this first"
      step "" "thing — it keeps the new one from ever locking."
    fi
  else
    step "unlock" "unlocked"
  fi
else
  step "unlock" "not locked"
fi

# The simulator is the sandbox's job, not this script's: it boots one
# before building, by UDID, and makes a fresh one if none will boot
# (server/simulators.mjs, `bootable`). Checking for one by NAME here passed
# for a device whose runtime was gone.

# caffeinate for as long as the sandbox runs, so the display cannot sleep
# out from under the panel even if a setting above did not stick.
export VNC_PASSWORD="$PASSWORD"
# The VNC password is the login password too, so the panel can type it into
# the lock screen when the Mac locks — which it does even with the lock
# "off", for reasons this script has not managed to pin down.
# The viewer judges "locked" from the pixels it is shown, not from the Mac's
# lock flag, which read "locked" while the screen was signed in.
[[ -n "$LOGIN_SET" ]] && export AUTO_UNLOCK=1
exec caffeinate -dis node "$(dirname "$0")/run-sandbox.mjs" "$@"
