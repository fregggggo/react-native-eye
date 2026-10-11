import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseUiautomator } from "../../src/layout/parseUiautomator.js";

describe("parseUiautomator", () => {
  it("converts bounds to x/y/w/h and extracts testID", () => {
    const xml =
      `<hierarchy><node bounds="[0,0][1080,2400]"><node text="Submit" resource-id="com.app:id/submit" bounds="[10,20][110,80]"/>` +
      `<node text="" resource-id="" bounds="[0,0][320,50]"/></node></hierarchy>`;
    const els = parseUiautomator(xml);
    expect(els[0]).toEqual({ text: "Submit", testID: "submit", x: 10, y: 20, w: 100, h: 60 });
  });

  it("returns [] when no nodes", () => {
    expect(parseUiautomator("<hierarchy></hierarchy>")).toEqual([]);
  });

  it("captures the short class name as type", () => {
    const xml = `<node text="Hi" class="android.widget.Button" bounds="[0,0][10,10]"/>`;
    expect(parseUiautomator(xml)[0].type).toBe("Button");
  });
});

describe("parseUiautomator decoding and visibility", () => {
  const screen = (nodes: string) =>
    `<hierarchy><node bounds="[0,0][1080,2400]">${nodes}</node></hierarchy>`;

  it("decodes XML entities so the text can actually be searched", () => {
    // "Tom &amp; Jerry" never matched a search for "Tom & Jerry".
    const xml = screen(`<node text="Tom &amp; Jerry &lt;3 &quot;x&quot;" bounds="[0,0][100,50]"/>`);
    expect(parseUiautomator(xml)[0].text).toBe('Tom & Jerry <3 "x"');
  });

  it("decodes numeric entities", () => {
    const xml = screen(`<node text="line&#10;break" bounds="[0,0][100,50]"/>`);
    expect(parseUiautomator(xml)[0].text).toBe("line\nbreak");
  });

  it("uses content-desc when there is no text", () => {
    const xml = screen(`<node content-desc="Close" bounds="[0,0][40,40]"/>`);
    expect(parseUiautomator(xml)[0].text).toBe("Close");
  });

  it("marks nodes outside the display off-screen and drops zero-sized ones", () => {
    const xml = screen(
      `<node text="Visible" bounds="[0,100][300,150]"/>` +
        `<node text="Scrolled away" bounds="[0,5000][300,5050]"/>` +
        `<node text="Ghost" bounds="[10,10][10,10]"/>`,
    );
    const els = parseUiautomator(xml);
    expect(els.find((e) => e.text === "Visible")!.offscreen).toBeUndefined();
    expect(els.find((e) => e.text === "Scrolled away")!.offscreen).toBe(true);
    expect(els.find((e) => e.text === "Ghost")).toBeUndefined();
  });
});

describe("parseUiautomator with the Android server's per-window roots", () => {
  // Shape of native/android-server /viewHierarchy (Maestro ViewHierarchy.dump), trimmed.
  const XML = [
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>`,
    `<hierarchy rotation="0">`,
    `  <node index="0" hintText="" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" bounds="[0,0][1440,145]">`,
    `    <node index="0" hintText="" text="12:30" resource-id="com.android.systemui:id/clock" class="android.widget.TextView" package="com.android.systemui" content-desc="" bounds="[60,40][200,110]" />`,
    `  </node>`,
    `  <node index="0" hintText="" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.demo.dev" content-desc="" bounds="[0,0][1440,3120]">`,
    `    <node index="0" hintText="" text="" resource-id="" class="android.widget.ScrollView" package="com.example.demo.dev" content-desc="" bounds="[0,145][1440,3120]">`,
    `      <node index="0" hintText="" text="Feed" resource-id="" class="android.widget.TextView" package="com.example.demo.dev" content-desc="" bounds="[40,200][400,280]" />`,
    `      <node index="1" hintText="Search" text="" resource-id="com.example.demo.dev:id/search" class="android.widget.EditText" package="com.example.demo.dev" content-desc="" bounds="[40,300][1400,420]" />`,
    `      <node index="2" hintText="" text="Half visible" resource-id="" class="android.widget.TextView" package="com.example.demo.dev" content-desc="" bounds="[40,3000][1400,3120]" />`,
    `      <node index="3" hintText="" text="Scrolled away" resource-id="" class="android.widget.TextView" package="com.example.demo.dev" content-desc="" bounds="[0,0][0,0]" />`,
    `    </node>`,
    `  </node>`,
    `  <node index="0" hintText="" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.demo.dev" content-desc="" bounds="[120,1000][1320,1800]">`,
    `    <node index="0" hintText="" text="OK" resource-id="android:id/button1" class="android.widget.Button" package="com.example.demo.dev" content-desc="" bounds="[1000,1600][1280,1760]" />`,
    `  </node>`,
    `  <node index="0" hintText="" text="" resource-id="" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" content-desc="" bounds="[0,1900][1440,3120]">`,
    `    <node index="0" hintText="" text="" resource-id="" class="android.view.View" package="com.google.android.inputmethod.latin" content-desc="q" bounds="[0,2000][144,2150]" />`,
    `  </node>`,
    `</hierarchy>`,
  ].join("\n");

  it("takes the largest non-system window as the viewport, not the status bar that comes first", () => {
    const els = parseUiautomator(XML);
    const feed = els.find((e) => e.text === "Feed")!;
    expect(feed.offscreen).toBeUndefined();
    expect(feed.visible).toBeUndefined();
  });

  it("keeps dialog and status-bar nodes but drops keyboard keys", () => {
    const texts = parseUiautomator(XML).map((e) => e.text);
    expect(texts).toContain("OK");
    expect(texts).toContain("12:30");
    expect(texts).not.toContain("q");
  });

  it("falls back to hintText for an empty field", () => {
    expect(parseUiautomator(XML).find((e) => e.testID === "search")!.text).toBe("Search");
  });

  it("drops nodes the server clipped to nothing", () => {
    expect(parseUiautomator(XML).find((e) => e.text === "Scrolled away")).toBeUndefined();
  });

  it("a nested node taller than the screen never becomes the viewport", () => {
    const xml =
      `<hierarchy><node bounds="[0,0][1080,2400]" package="a">` +
      `<node text="Long list" bounds="[0,0][1080,9000]" package="a"><node text="Row" bounds="[0,100][1080,200]" package="a"/></node>` +
      `</node></hierarchy>`;
    const list = parseUiautomator(xml).find((e) => e.text === "Long list")!;
    expect(list.visible).toEqual({ x: 0, y: 0, w: 1080, h: 2400 });
  });

  it("uses the largest root when every root is system UI (lock screen, shade)", () => {
    const xml =
      `<hierarchy><node bounds="[0,0][1440,145]" package="com.android.systemui"/>` +
      `<node bounds="[0,0][1440,3120]" package="com.android.systemui"><node text="Unlock" bounds="[500,2800][900,2900]" package="com.android.systemui"/></node></hierarchy>`;
    expect(parseUiautomator(xml).find((e) => e.text === "Unlock")!.offscreen).toBeUndefined();
  });

  it("a Toast with bounds is a normal text element and never becomes the viewport; one without bounds is skipped", () => {
    const xml =
      `<hierarchy><node bounds="[0,0][1440,3120]" package="com.app"><node text="Feed" bounds="[0,200][400,280]" package="com.app"/></node>` +
      `<node text="Saved" class="android.widget.Toast" package="com.app" bounds="[400,2800][1040,2900]"/>` +
      `<node text="No bounds toast" class="android.widget.Toast" package="com.app"/></hierarchy>`;
    const els = parseUiautomator(xml);
    expect(els.find((e) => e.text === "Saved")).toMatchObject({ type: "Toast", x: 400, y: 2800 });
    expect(els.find((e) => e.text === "Feed")!.offscreen).toBeUndefined();
    expect(els.find((e) => e.text === "No bounds toast")).toBeUndefined();
  });
});

describe("parseUiautomator: the Android server's synthetic toast node (ViewHierarchy.addToastNode)", () => {
  // Attribute order and values exactly as the server serialises them.
  const APP = `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.app" content-desc="" bounds="[0,0][1440,3120]"><node index="0" text="Feed" resource-id="" class="android.widget.TextView" package="com.app" content-desc="" bounds="[0,200][400,280]"/></node>`;
  const STATUS_BAR = `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" bounds="[0,0][1440,145]"/>`;
  const toast = (bounds: string, pkg = "com.app") =>
    `<node index="0" text="Saved" resource-id="" class="android.widget.Toast" package="${pkg}" content-desc="" visible-to-user="true" checkable="false" clickable="false" bounds="${bounds}"/>`;

  it("a toast from a server build without toast bounds ([0,0][0,0]) is placed in the bottom-centre band, on screen", () => {
    const els = parseUiautomator(`<hierarchy rotation="0">${STATUS_BAR}${APP}${toast("[0,0][0,0]", "")}</hierarchy>`);
    const saved = els.find((e) => e.text === "Saved")!;
    // Same arithmetic as ViewHierarchy.toastBounds on a 1440x3120 display.
    expect(saved).toMatchObject({ type: "Toast", x: 144, y: 2652, w: 1152, h: 156 });
    expect(saved.offscreen).toBeUndefined();
    expect(saved.visible).toBeUndefined();
  });

  it("a toast with the server's estimated bounds is a normal on-screen element", () => {
    const els = parseUiautomator(`<hierarchy rotation="0">${STATUS_BAR}${APP}${toast("[144,2652][1296,2808]")}</hierarchy>`);
    expect(els.find((e) => e.text === "Saved")).toMatchObject({ type: "Toast", x: 144, y: 2652, w: 1152, h: 156 });
    expect(els.find((e) => e.text === "Feed")!.offscreen).toBeUndefined();
  });

  it("a toast over a system-UI screen never becomes the viewport (it is a depth-0 node, not a window)", () => {
    const shade = `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" bounds="[0,0][1440,3120]"><node index="0" text="Wi-Fi" resource-id="" class="android.widget.TextView" package="com.android.systemui" content-desc="" bounds="[100,400][500,480]"/></node>`;
    const els = parseUiautomator(`<hierarchy rotation="0">${shade}${toast("[144,2652][1296,2808]")}</hierarchy>`);
    expect(els.find((e) => e.text === "Wi-Fi")!.offscreen).toBeUndefined();
    expect(els.find((e) => e.text === "Saved")!.offscreen).toBeUndefined();
  });
});

describe("parseUiautomator on a real Android server hierarchy (demo-app feed, API 36)", () => {
  const xml = readFileSync(new URL("../fixtures/uiautomator/server-demo-app.xml", import.meta.url), "utf8");
  const els = parseUiautomator(xml);

  it("finds the app's elements and none of them is off-screen at the top (the status bar is not the viewport)", () => {
    expect(els.length).toBeGreaterThan(10);
    const onScreen = els.filter((e) => !e.offscreen);
    expect(onScreen.length).toBeGreaterThan(10);
  });

  it("contains a label the feed shows", () => {
    expect(els.map((e) => e.text)).toContain("For You");
  });
});
