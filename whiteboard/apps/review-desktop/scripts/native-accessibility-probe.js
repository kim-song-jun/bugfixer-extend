/* global ObjC, $ */
/* exported run */

function run() {
  let failurePhase = "IMPORT";

  try {
    ObjC.import("ApplicationServices");
    ObjC.import("Foundation");

    failurePhase = "OPTIONS";

    const options = $.NSDictionary.dictionaryWithObjectForKey(
      $.NSNumber.numberWithBool(false),
      $.kAXTrustedCheckOptionPrompt,
    );

    failurePhase = "QUERY";
    const trustedResult = $.AXIsProcessTrustedWithOptions(options);

    failurePhase = "VALUE";

    if (![true, false, 0, 1].includes(trustedResult)) {
      throw new Error("AX trust API returned an unsupported scalar type");
    }

    failurePhase = "SERIALIZE";

    return JSON.stringify({
      currentHelperPID: Number($.NSProcessInfo.processInfo.processIdentifier),
      currentClientTrusted: trustedResult === true || trustedResult === 1,
      promptRequested: false,
      nativePickerFlowExercised: false,
    });
  } catch {
    return JSON.stringify({ failurePhase });
  }
}
