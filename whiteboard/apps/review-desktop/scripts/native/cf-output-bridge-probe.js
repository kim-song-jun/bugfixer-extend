/* global ObjC, $, Ref */
/* exported run */

const MODES = new Set(["bound-id-ref", "bound-pointer-ref"]);

function run(argv) {
  const mode = argv[0];
  let phase = "IMPORT";
  let ownPID = null;
  let fixtureVerified = false;
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
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    ObjC.import("Foundation");
    ObjC.import("CoreFoundation");

    phase = "OWN_PID";
    ownPID = Number($.NSProcessInfo.processInfo.processIdentifier);

    if (!Number.isSafeInteger(ownPID) || ownPID < 1 || ownPID > 2_147_483_647) {
      ownPID = null;
      errorCode = "own-pid-unavailable";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    emitProgress(mode, ownPID, "OWN_PID");
    phase = "FIXTURE";
    emitProgress(mode, ownPID, phase);

    const key = $.NSString.stringWithString("abi-fixture-key");
    const expected = $.NSString.stringWithString("abi-fixture-value");

    const dictionary = $.NSDictionary.dictionaryWithObjectForKey(expected, key);
    phase = "FIXTURE_READBACK";
    emitProgress(mode, ownPID, phase);
    const fixtureValue = dictionary.objectForKey(key);

    if (fixtureValue === null || fixtureValue === undefined) {
      errorCode = "fixture-value-unavailable";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "FIXTURE_CLASS";
    emitProgress(mode, ownPID, phase);
    const fixtureClassMatches = fixtureValue.isKindOfClass($.NSString);

    if (fixtureClassMatches !== true && fixtureClassMatches !== 1) {
      errorCode = "fixture-value-not-cfstring";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "FIXTURE_EQUALITY";
    emitProgress(mode, ownPID, phase);
    const fixtureEqual = fixtureValue.isEqualToString(expected);

    if (fixtureEqual !== true && fixtureEqual !== 1) {
      errorCode = "fixture-value-mismatch";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    fixtureVerified = true;

    phase = "FUNCTION_BINDING";
    emitProgress(mode, ownPID, phase);
    const outputValueType = mode === "bound-id-ref" ? "id" : "pointer";

    ObjC.bindFunction("CFGetTypeID", ["unsigned long", [outputValueType]]);
    ObjC.bindFunction("CFEqual", ["bool", [outputValueType, "id"]]);
    ObjC.bindFunction("CFDictionaryGetValueIfPresent", [
      "bool",
      ["id", "id", "pointer"],
    ]);

    phase = "OUTPUT_REF";
    emitProgress(mode, ownPID, phase);
    const output = mode === "bound-id-ref" ? Ref("id") : Ref("pointer");

    phase = "DICTIONARY_LOOKUP";
    emitProgress(mode, ownPID, phase);
    const present = $.CFDictionaryGetValueIfPresent(dictionary, key, output);

    if (present !== true && present !== 1) {
      errorCode = "cf-lookup-key-not-found";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        fixtureVerified,
        false,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    found = true;

    phase = "OUTPUT_VALUE";
    emitProgress(mode, ownPID, phase);
    const value = output[0];

    if (value === null || value === undefined) {
      errorCode = "output-value-unavailable";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "VALUE_TYPE";
    emitProgress(mode, ownPID, phase);

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
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "VALUE_EQUALITY";
    emitProgress(mode, ownPID, phase);

    const equal = $.CFEqual(value, expected);
    valuesEqual = equal === true || equal === 1;

    if (!valuesEqual) {
      errorCode = "output-value-mismatch";

      return makeReceipt(
        mode,
        ownPID,
        phase,
        fixtureVerified,
        found,
        valueTypeMatches,
        valuesEqual,
        errorCode,
      );
    }

    phase = "COMPLETE";
    emitProgress(mode, ownPID, phase);

    return makeReceipt(
      mode,
      ownPID,
      phase,
      fixtureVerified,
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
      fixtureVerified,
      found,
      valueTypeMatches,
      valuesEqual,
      errorCode,
    );
  }
}

function emitProgress(mode, ownPID, phase) {
  const event = JSON.stringify({
    event: "cf-output-progress",
    mode,
    ownPID,
    phase,
  });

  const data = $.NSString.stringWithString(`${event}\n`).dataUsingEncoding(
    $.NSUTF8StringEncoding,
  );

  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function makeReceipt(
  mode,
  ownPID,
  phase,
  fixtureVerified,
  found,
  valueTypeMatches,
  valuesEqual,
  errorCode,
) {
  return JSON.stringify({
    mode,
    ownPID,
    phase,
    fixtureVerified,
    found,
    valueTypeMatches,
    valuesEqual,
    errorCode,
  });
}
