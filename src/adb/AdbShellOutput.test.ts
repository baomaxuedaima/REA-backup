import { describe, expect, it } from "vitest";

import {
  parseAmStartOutput,
  parseDumpsysPackageOutput,
} from "./AdbShellOutput.js";

const packageDump = (installerLine: string | undefined): string =>
  [
    "Packages:",
    "  Package [com.example] (abcdef):",
    "    versionName=1.2.3",
    ...(installerLine === undefined ? [] : [`    ${installerLine}`]),
    "    pkgFlags=[ HAS_CODE ]",
    "",
  ].join("\n");

describe("parseDumpsysPackageOutput", () => {
  it("keeps a reported installer package name", () => {
    expect(
      parseDumpsysPackageOutput(
        packageDump("installerPackageName=com.android.vending"),
      ).installerPackageName,
    ).toBe("com.android.vending");
  });

  // Package Manager prints an absent String field as the text "null"; a
  // missing or empty declaration means the same absence (morluto/rea#3943).
  it.each([
    ["the literal null sentinel", "installerPackageName=null"],
    ["an empty value", "installerPackageName="],
    ["a missing line", undefined],
  ])("reports an absent installer as null for %s", (_case, line) => {
    expect(parseDumpsysPackageOutput(packageDump(line))).toMatchObject({
      versionName: "1.2.3",
      installerPackageName: null,
    });
  });

  it("reports an absent version name as null", () => {
    expect(
      parseDumpsysPackageOutput(
        packageDump("installerPackageName=null").replace(
          "versionName=1.2.3",
          "versionName=null",
        ),
      ).versionName,
    ).toBeNull();
  });
});

const starting =
  "Starting: Intent { act=android.intent.action.MAIN cmp=com.example/.Main }";

describe("parseAmStartOutput", () => {
  it("recognizes a CRLF wait-timeout report", () => {
    expect(
      parseAmStartOutput(
        `${starting}\r\nStatus: timeout\r\nActivity: com.example/.Main\r\nComplete\r\n`,
      ),
    ).toMatchObject({
      status: "refused",
      activity: "com.example/.Main",
      reportedStatus: "timeout",
      reason: "am start reported status: timeout",
    });
  });

  it("treats every non-ok status as refusal, including a later status after ok", () => {
    expect(
      parseAmStartOutput(`${starting}\nStatus: ok\nStatus: timeout\n`),
    ).toMatchObject({
      status: "refused",
      reportedStatus: "timeout",
      reason: "am start reported status: timeout",
    });
    expect(
      parseAmStartOutput(`${starting}\nStatus: future-value\n`),
    ).toMatchObject({
      status: "refused",
      reportedStatus: "future-value",
    });
  });

  it("gives hard errors in either stream priority over status and attempt", () => {
    expect(
      parseAmStartOutput(
        `${starting}\nStatus: timeout\nActivity: com.example/.Main\n`,
        "Exception: Activity class does not exist\n",
      ),
    ).toEqual({
      status: "refused",
      startedActivity: "act=android.intent.action.MAIN cmp=com.example/.Main",
      activity: "com.example/.Main",
      reportedStatus: "timeout",
      reason: "Activity class does not exist",
    });
    expect(
      parseAmStartOutput(
        `${starting}\nStatus: ok\nError: Activity class does not exist\n`,
      ),
    ).toMatchObject({
      status: "refused",
      reason: "Activity class does not exist",
    });
  });

  it("keeps Starting-only output compatible and refuses no-attempt output", () => {
    expect(parseAmStartOutput(starting)).toMatchObject({
      status: "started",
      reportedStatus: null,
      activity: null,
    });
    expect(
      parseAmStartOutput("Status: ok\nWarning: Activity not started\n"),
    ).toMatchObject({
      status: "refused",
      startedActivity: null,
      reportedStatus: "ok",
    });
  });
});
