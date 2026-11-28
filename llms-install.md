# Installing react-native-eye (for AI agents)

react-native-eye is a stdio MCP server published on npm. It connects to a running React Native app through Metro. Nothing needs to be cloned, built or added to the app.

## 1. Check the prerequisites

Run these checks and tell the user about anything missing. Do not install system tools without asking.

- `node --version` must be 18 or newer.
- For iOS: the host must be macOS with Xcode. `xcrun simctl list devices booted` should show a booted simulator.
- For Android: `adb devices` should list an emulator or device.
- The user's app must run as a dev build with Metro (`npx expo start`, `npx react-native start` or the project's usual command). React Native 0.70+ or Expo SDK 54+, with Hermes.

## 2. Add the server to the MCP settings

Add this entry to the `mcpServers` object of the client's MCP settings file (for Cline: `cline_mcp_settings.json`). Keep any servers already there.

```json
{
  "mcpServers": {
    "react-native-eye": {
      "command": "npx",
      "args": ["-y", "react-native-eye@latest"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Metro on the standard ports (8081–8083, 19000–19002) is found automatically. If the user runs Metro on another port, add `"--port", "<port>"` to `args` or set `"env": { "METRO_PORT": "<port>" }`.

No API keys or accounts are needed. The server sends no telemetry and talks only to localhost.

## 3. Verify

1. Call the `connect` tool. It should report the app and the device it found.
2. Call `observe`. It should return the elements on the current screen.

On the first call per device, the server installs a small native driver (iOS runner app or Android APK). This takes a few seconds once.

## Troubleshooting

- **No app found:** Metro is not running, or the app is not open in the simulator or emulator. Start both and call `connect` again.
- **Wrong port:** pass the port to `connect`, or set `METRO_PORT` as above.
- **Native driver problems:** set `"env": { "RNE_NATIVE_DRIVER": "off" }`. On iOS, OS-level input then needs the AXe CLI (`brew install cameroncooke/axe/axe`).

Full documentation: https://github.com/fregggggo/react-native-eye#readme
