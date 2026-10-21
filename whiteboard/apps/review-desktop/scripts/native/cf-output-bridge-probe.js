/* global ObjC, $, Ref */
/* exported run */

const MODES = new Set([
  "metadata-ref",
  "bound-untyped-ref",
  "bound-pointer-ref",
  "bound-id-ref",
]);

function run(argv) {
  const mode = argv[0];
  let phase = "IMPORT";
  let ownPID = null;
  let found = null;
  let valueTypeMatches = null;
  let valuesEqual = null;
  let errorCode = null;

  try {
    if (!MODES.has(mode)) {
      phase = "INPUT";
      errorCode = "invalid-mode";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    ObjC.import("Foundation");
    ObjC.import("CoreFoundation");
    ObjC.bindFunction("CFGetTypeID", ["unsigned long", ["pointer"]]);
    ObjC.bindFunction("CFEqual", ["bool", ["pointer", "pointer"]]);

    phase = "OWN_PID";
    ownPID = Number($.NSProcessInfo.processInfo.processIdentifier);

    if (!Number.isSafeInteger(ownPID) || ownPID < 1 || ownPID > 2_147_483_647) {
      ownPID = null;
      errorCode = "own-pid-unavailable";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "FIXTURE";

    const key = $.NSString.stringWithString("abi-fixture-key");
    const expected = $.NSString.stringWithString("abi-fixture-value");

    const dictionary = $.NSDictionary.dictionaryWithObjectForKey(expected, key);

    if (mode !== "metadata-ref") {
      phase = "FUNCTION_BINDING";
      ObjC.bindFunction("CFDictionaryGetValueIfPresent", [
        "bool",
        ["pointer", "pointer", "pointer"],
      ]);
    }

    phase = "OUTPUT_REF";
    let output = Ref();

    if (mode === "bound-pointer-ref") {
      output = Ref("pointer");
    } else if (mode === "bound-id-ref") {
      output = Ref("id");
    }

    phase = "DICTIONARY_LOOKUP";
    const present = $.CFDictionaryGetValueIfPresent(dictionary, key, output);

    if (present !== true && present !== 1) {
      errorCode = "fixture-key-not-found";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        false,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    found = true;

    const value = output[0];

    if (value === null || value === undefined) {
      phase = "OUTPUT_VALUE";
      errorCode = "output-value-unavailable";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "VALUE_TYPE";

    const actualTypeID = Number($.CFGetTypeID(value));
    const expectedTypeID = Number($.CFStringGetTypeID());
    valueTypeMatches =
      Number.isSafeInteger(actualTypeID) &&
      actualTypeID > 0 &&
      Number.isSafeInteger(expectedTypeID) &&
      expectedTypeID > 0 &&
      actualTypeID === expectedTypeID;

    if (!valueTypeMatches) {
      errorCode = "output-value-not-cfstring";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "VALUE_EQUALITY";

    const equal = $.CFEqual(value, expected);
    valuesEqual = equal === true || equal === 1;

    if (!valuesEqual) {
      errorCode = "output-value-mismatch";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "COMPLETE";

    return makeReceipt(
      mode,
      ownPID,
      phase,
      found,
      valueTypeMatches,
      valuesEqual,
      errorCode,
    );
  } catch {
    errorCode = errorCode || "bridge-operation-threw";

    return makeReceipt(
      mode,
      ownPID,
      phase,
      found,
      valueTypeMatches,
      valuesEqual,
      errorCode,
    );
  }
}

function makeReceipt(
  mode,
  ownPID,
  phase,
  found,
  valueTypeMatches,
  valuesEqual,
  errorCode,
) {
  return JSON.stringify({
    mode,
    ownPID,
    phase,
    found,
    valueTypeMatches,
    valuesEqual,
    errorCode,
  });
}
