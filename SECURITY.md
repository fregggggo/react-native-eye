# Security

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include the react-native-eye version, your MCP client, the platform (iOS simulator or Android emulator) and the steps to reproduce. You will get an answer within a week.

## What counts

react-native-eye runs on your machine as a child process of your MCP client. It talks only to localhost: Metro's debugger endpoint and the native drivers it installs on the simulator or emulator. Reports we especially want:

- any network traffic that leaves the machine;
- a way for the app, a web page or another local process to make the server run commands, read files or install anything the user did not ask for;
- a native driver that stays reachable from outside the device or the host after the session ends.

## By design

These are features, not vulnerabilities:

- `eval_js` runs arbitrary JavaScript in the connected app, and the tap, type and navigation tools drive it. That power is the point of the server; it is available only to the MCP client that started it.
- The server reads logs, network requests and store state of a dev build. Do not point it at an app holding data you would not show the agent.
- Only dev builds are supported. A production build has no Metro connection to attach to.

## Supported versions

Fixes go into the latest release on npm.
