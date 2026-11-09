# VoiceDock privacy policy

Last updated: November 9, 2026 (extension version 1.2.0).

VoiceDock is a Chrome extension that reads the text you select aloud.
It has no developer server, no accounts, no analytics, no tracking and no telemetry.
Nothing VoiceDock handles is ever sent to the developer.

## What VoiceDock reads

- **The text you ask it to read.** When you choose *Read selected text aloud* in the right-click menu or press the read shortcut, VoiceDock takes the text you selected on that page.
  The test buttons and the Get started page read a fixed sample sentence instead.
- **Only the page you read from.** VoiceDock has no script on the sites you visit.
  When you use the right-click menu or the shortcut, Chrome gives VoiceDock access to that one tab (the `activeTab` permission), and VoiceDock adds a small script to it.
  That script reads the current selection and shows the player bar and short notes such as "Select text first".
  It does not read anything else on the page, and it stops when you leave or reload the page.

## Where the text goes

It depends on the voice your profile uses.

- **Piper or Kokoro (local voices).**
  The text is sent to a speech server running on your own computer, at `http://127.0.0.1:7477` (Piper) or `http://127.0.0.1:7478` (Kokoro).
  `127.0.0.1` is your computer's loopback address: the request never leaves the machine.
  You install and run these servers yourself; they are open source, in the same repository as the extension.
  They turn the text into audio and send it back; they keep no copy of the text and do not log it.
  The Piper server writes each piece of audio to a temporary file in its own folder and deletes it as soon as it has been sent; the Kokoro server keeps audio in memory only.
  The servers are local web servers, not Chrome native messaging hosts, and they only answer requests from Chrome extensions or from programs on your computer, never from web pages.
- **The Basic voice (Chrome's built-in speech).**
  The text is passed to Chrome's own text-to-speech (`chrome.tts`).
  VoiceDock asks Chrome for a voice that runs on your device (one of your operating system's voices).
  Only when your system has no on-device voice does Chrome use its default voice; in Google Chrome that can be an online Google voice, in which case Chrome sends the text to Google to speak it, under [Google's privacy policy](https://policies.google.com/privacy).
  This is the voice a new install uses, and the fallback when Piper or Kokoro isn't running (you can turn the fallback off in Settings).

VoiceDock makes no other network requests.
Its only requests go to `127.0.0.1` (to check whether Piper and Kokoro are running, list, delete and open their voices on the Voices tab, and read text), and it loads no remote code.
Links in its pages (the setup guide, Node.js, credits) open only when you click them.

## Data stored on your device

VoiceDock stores these settings in `chrome.storage.local`, on your device only:

- Your profiles: each one's name, voice engine, voice, speed and volume, and which profile is active.
- Favorite voices for Piper and Kokoro, voices you deleted, and whether to show favorites only.
- Whether the Basic voice fallback is on, and a settings version number.

VoiceDock does not store the text you read, a reading history, or the pages you read from.
Uninstalling VoiceDock removes all of its storage from your Chrome profile.

## What VoiceDock does not do

- It does not collect, sell or share personal data, and does not use data for advertising, profiling, creditworthiness or lending.
- It does not track your browsing or run on pages you have not read from.
- It does not send anything to the developer or to any server other than the ones described above.

## Chrome Web Store User Data Policy

VoiceDock's use of the information it handles complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/), including its Limited Use requirements.
It uses the text you select only to read it aloud, and transfers it only to the speech engine your profile uses: a server on your own computer, or Chrome's built-in speech.

## Permissions

- `activeTab`: access to the tab you read from, only after you use the right-click menu or the shortcut there.
- `scripting`: adds VoiceDock's page script (selection, player bar and notes) to that tab.
- `contextMenus`: the *Read selected text aloud*, *Read as...* and *Stop reading* menu items.
- `tts`: the Basic voice, Chrome's built-in speech.
- `offscreen`: a hidden extension page that plays the audio Piper and Kokoro return, because an extension's background worker can't play audio.
- `storage`: the settings listed above.
- `http://127.0.0.1:7477/*` and `http://127.0.0.1:7478/*`: the Piper and Kokoro servers on your own computer.

## Contact

Questions or concerns: email [contact@n8builds.dev](mailto:contact@n8builds.dev) or open an issue at [github.com/n8watkins/voicedock/issues](https://github.com/n8watkins/voicedock/issues).

## Changes

Material changes to this policy will be published here and at [n8builds.dev/privacy/voicedock](https://n8builds.dev/privacy/voicedock) with a new date.
