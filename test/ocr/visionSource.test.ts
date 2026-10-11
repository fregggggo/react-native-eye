import { describe, it, expect } from "vitest";
import { VISION_OCR_SOURCE } from "../../src/ocr/visionSource.js";

describe("VISION_OCR_SOURCE", () => {
  it("recognizes text with Vision and keeps the top candidate per line", () => {
    expect(VISION_OCR_SOURCE).toContain("VNRecognizeTextRequest");
    expect(VISION_OCR_SOURCE).toContain("topCandidates(1)");
    expect(VISION_OCR_SOURCE).toContain("recognitionLevel = .accurate");
  });

  it("auto-detects the language unless languages are given, resolving short codes", () => {
    expect(VISION_OCR_SOURCE).toContain("automaticallyDetectsLanguage = true");
    expect(VISION_OCR_SOURCE).toContain("supportedRecognitionLanguages()");
    expect(VISION_OCR_SOURCE).toContain("request.recognitionLanguages = resolved");
  });

  it("flips Vision's bottom-left normalized boxes into top-left pixels", () => {
    expect(VISION_OCR_SOURCE).toContain("(1 - box.maxY) * height");
    expect(VISION_OCR_SOURCE).toContain("box.minX * width");
  });

  it("prints one JSON object on stdout and fails with exit code 2", () => {
    expect(VISION_OCR_SOURCE).toContain("JSONSerialization.data(withJSONObject: payload");
    expect(VISION_OCR_SOURCE).toContain("FileHandle.standardOutput.write(data)");
    expect(VISION_OCR_SOURCE).toContain("exit(2)");
  });

  it("keeps Swift escapes intact (interpolation and newlines survive the TS literal)", () => {
    expect(VISION_OCR_SOURCE).toContain('\\(a)');
    expect(VISION_OCR_SOURCE).toContain('"\\n"');
  });

  it("contains no URLs and nothing that could break the template literal", () => {
    expect(VISION_OCR_SOURCE).not.toMatch(/https?:\/\//i);
    expect(VISION_OCR_SOURCE).not.toContain("`");
    expect(VISION_OCR_SOURCE).not.toContain("${");
  });
});
