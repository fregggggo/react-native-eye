# Contributing

Bug reports and pull requests are welcome.

## Reporting a bug

Open an issue with:

- react-native-eye version, Node version and your MCP client;
- React Native or Expo version, and whether the app runs on the New Architecture;
- the platform: iOS simulator (iOS version) or Android emulator (API level);
- the tool call and its full response. Every response says which path ran (`js`, `os`, `runner`), which usually tells us where to look.

Security issues go through [SECURITY.md](SECURITY.md), not issues.

## Development

```sh
npm install
npm run build        # compile to build/
npm test             # unit tests, no device needed
npm run dev          # run the server from source
```

- `npm run test:integration` drives a real device. Boot an iOS simulator and set `RNE_INTEGRATION_UDID` to its udid, or start an Android emulator and set `RNE_INTEGRATION_ANDROID_SERIAL`.
- `scripts/build-drivers.sh` rebuilds the native drivers under `native/` (Xcode for iOS; JDK 17+ and the Android SDK for Android). Any change under `native/` changes the driver version.
- `scripts/pack-test.sh` packs the tarball, installs it into a fresh project and checks that the drivers arrive intact and the server answers.

## Pull requests

- Keep each pull request to one change, with tests. Unit tests use recorded fixtures (`test/fixtures/`), so most fixes need no device.
- `npm run build` and `npm test` must pass; CI runs them on Node 18, 20 and 22.
- The server must not reach anything beyond localhost. A test fails the build if an external URL appears in `src/`.
- Code under `native/` builds into the drivers that ship prebuilt in the npm package. Say in the pull request which platforms you rebuilt and ran.

By contributing you agree that your work is released under the [MIT license](LICENSE).
