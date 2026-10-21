/* global ObjC, $, Ref */
/* exported run */

const MODES = new Set([
  "metadata-ref",
  "bound-pointer-ref",
  "bound-int-ref",
  "bound-int-pointer-ref",
]);

function run(argv) {
  const mode = argv[0];
  let phase = "IMPORT";
  let ownPID = null;
  let status = null;
  let returnedPID = null;
  let errorCode = null;

  try {
    if (!MODES.has(mode)) {
      phase = "INPUT";
      errorCode = "invalid-mode";

      return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
    }

    ObjC.import("ApplicationServices");
    ObjC.import("Foundation");
    ObjC.import("CoreFoundation");
    ObjC.bindFunction("CFGetTypeID", ["unsigned long", ["pointer"]]);

    phase = "OWN_PID";
    ownPID = Number($.NSProcessInfo.processInfo.processIdentifier);

    if (
      !Number.isSafeInteger(ownPID) ||
      ownPID < 1 ||
      ownPID > 2_147_483_647
    ) {
      ownPID = null;
      errorCode = "own-pid-unavailable";

      return makeReceipt(mode, null, status, returnedPID, phase, errorCode);
    }

    phase = "APPLICATION";
    const application = $.AXUIElementCreateApplication(ownPID);

    phase = "ELEMENT_TYPE";
    const actualTypeID = Number($.CFGetTypeID(application));
    const expectedTypeID = Number($.AXUIElementGetTypeID());

    if (
      !Number.isSafeInteger(actualTypeID) ||
      actualTypeID < 0 ||
      !Number.isSafeInteger(expectedTypeID) ||
      expectedTypeID < 0 ||
      actualTypeID !== expectedTypeID
    ) {
      errorCode = "element-type-mismatch";

      return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
    }

    if (mode !== "metadata-ref") {
      phase = "PID_BINDING";
      ObjC.bindFunction("AXUIElementGetPid", ["int", ["pointer", "pointer"]]);
    }

    phase = "PID_QUERY";
    let pidReference;

    if (mode === "metadata-ref" || mode === "bound-pointer-ref") {
      pidReference = Ref();
    } else if (mode === "bound-int-ref") {
      pidReference = Ref("int");
    } else {
      pidReference = Ref("int*");
    }

    status = Number($.AXUIElementGetPid(application, pidReference));

    if (
      !Number.isSafeInteger(status) ||
      status < -2_147_483_648 ||
      status > 2_147_483_647
    ) {
      status = null;
      errorCode = "status-invalid";

      return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
    }

    if (status !== 0) {
      errorCode = "ax-error-status-nonzero";

      return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
    }

    phase = "PID_VALUE";
    returnedPID = Number(pidReference[0]);

    if (
      !Number.isSafeInteger(returnedPID) ||
      returnedPID < 1 ||
      returnedPID > 2_147_483_647
    ) {
      returnedPID = null;
      errorCode = "returned-pid-invalid";

      return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
    }

    if (returnedPID !== ownPID) {
      errorCode = "returned-pid-mismatch";

      return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
    }

    phase = "COMPLETE";

    return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
  } catch {
    errorCode = errorCode || "bridge-operation-threw";

    return makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode);
  }
}

function makeReceipt(mode, ownPID, status, returnedPID, phase, errorCode) {
  return JSON.stringify({
    mode,
    ownPID,
    status,
    returnedPID,
    phase,
    errorCode,
  });
}
