/* global ObjC, $, Ref */
/* exported run */

const ALLOWED_ROLES = new Set([
  "AXApplication",
  "AXWindow",
  "AXSheet",
  "AXGroup",
  "AXTextField",
  "AXButton",
  "AXStaticText",
  "AXToolbar",
  "AXScrollArea",
  "AXOutline",
  "AXTable",
  "AXRow",
  "AXCell",
  "AXColumn",
  "AXImage",
  "AXPopUpButton",
  "AXRadioButton",
  "AXCheckBox",
  "AXSplitGroup",
  "AXDisclosureTriangle",
  "AXList",
  "AXBrowser",
  "AXProgressIndicator",
  "AXComboBox",
  "AXMenuButton",
  "AXSlider",
  "AXValueIndicator",
  "AXTokenField",
  "AXSecureTextField",
  "AXTextArea",
  "AXIncrementor",
  "AXTabGroup",
  "AXTab",
  "AXMenu",
  "AXMenuItem",
  "AXUnknown",
  "AXOther",
]);

const PATH_SEMANTICS = new Set([
  "AXPathField",
  "Go to Folder",
  "Go to Folder:",
  "Folder Path",
  "Folder Path:",
  "폴더 경로",
  "폴더 경로:",
  "폴더로 이동",
  "폴더로 이동:",
]);

let AX;

let expectedAXPID;

let retainedArrays;

let failureCode;

let typeIdDiagnostic;

let pidQueryStatus;

let windowRoleFailureStage;

let windowRoleAXErrorStatus;

let readingHomeWindowRole;

let windowsAttributeAXErrorStatus;

let pidMismatchDiagnostic;

let panelPidMismatchDiagnostic;

let arrayQueryDiagnostic;

let guardRequestHandle;

let guardResponseHandle;

let guardRequestId;

let guardRequestCount;

let sheetOwnerPID;

let servicePID;

let serviceDiscoveryAttempted;

let cleanupInProgress;

let serviceBirthSeconds;

let serviceBirthMicroseconds;

let inputTransportStage;

let inputPayloadByteCount;

let inputTargetPathLength;

let sheetPIDRelation;

let cancelCandidateCount;

let cancelControlStage;

let cancelReferenceDiagnostic;

let cancelMutationAttemptCount;

let guardTransportStage;

function run(argv) {
  let failurePhase = "IMPORT";
  let appPID = null;
  let currentHelperPID = null;
  let currentClientTrusted = null;
  const promptRequested = false;
  let homeWindow;
  let sheet;
  let roleCounts = {};
  let actionCount = 0;
  let windowCount = 0;
  let sheetCount = 0;
  let textFieldCount = 0;
  let settableTextFieldCount = 0;
  let semanticPathFieldCount = 0;
  let defaultActionCount = 0;
  let cleanupStatus = "not-needed";
  failureCode = null;
  typeIdDiagnostic = null;
  pidQueryStatus = null;
  windowRoleFailureStage = null;
  windowRoleAXErrorStatus = null;
  readingHomeWindowRole = false;
  windowsAttributeAXErrorStatus = null;
  pidMismatchDiagnostic = null;
  panelPidMismatchDiagnostic = null;
  arrayQueryDiagnostic = null;
  guardRequestHandle = null;
  guardResponseHandle = null;
  guardRequestId = 0;
  guardRequestCount = 0;
  sheetOwnerPID = null;
  servicePID = null;
  serviceDiscoveryAttempted = false;
  cleanupInProgress = false;
  serviceBirthSeconds = null;
  serviceBirthMicroseconds = null;
  inputTransportStage = null;
  inputPayloadByteCount = null;
  inputTargetPathLength = null;
  sheetPIDRelation = null;
  cancelCandidateCount = null;
  cancelControlStage = null;
  cancelMutationAttemptCount = 0;
  cancelReferenceDiagnostic = {
    appOwnerAttributePresentCount: null,
    serviceOwnerAttributePresentCount: null,
    uniqueReferenceCount: null,
    listedReferenceMatchCount: null,
    buttonRoleMatchCount: null,
    pressActionMatchCount: null,
  };
  guardTransportStage = null;

  const mode = argv[0];
  appPID = Number(argv[1]);

  try {
    ObjC.import("ApplicationServices");
    ObjC.import("Foundation");
    ObjC.import("CoreFoundation");
    ObjC.bindFunction("CFGetTypeID", ["unsigned long", ["pointer"]]);
    ObjC.bindFunction("CFArrayGetCount", ["long", ["pointer"]]);
    ObjC.bindFunction("CFArrayGetValueAtIndex", [
      "pointer",
      ["pointer", "long"],
    ]);
    ObjC.bindFunction("CFArrayGetTypeID", ["unsigned long", []]);
    ObjC.bindFunction("CFStringGetTypeID", ["unsigned long", []]);
    ObjC.bindFunction("CFStringCompare", [
      "long",
      ["pointer", "id", "unsigned long"],
    ]);
    ObjC.bindFunction("CFEqual", ["bool", ["pointer", "pointer"]]);
    ObjC.bindFunction("AXUIElementGetPid", ["int", ["pointer", "pointer"]]);
    ObjC.bindFunction("AXUIElementCopyAttributeValue", [
      "int",
      ["pointer", "id", "pointer"],
    ]);
    ObjC.bindFunction("AXUIElementIsAttributeSettable", [
      "int",
      ["pointer", "id", "pointer"],
    ]);
    ObjC.bindFunction("AXUIElementCopyActionNames", [
      "int",
      ["pointer", "pointer"],
    ]);
    ObjC.bindFunction("AXUIElementPerformAction", ["int", ["pointer", "id"]]);
    ObjC.bindFunction("AXUIElementSetAttributeValue", [
      "int",
      ["pointer", "id", "id"],
    ]);
    AX = {
      windows: $("AXWindows"),
      role: $("AXRole"),
      children: $("AXChildren"),
      parent: $("AXParent"),
      value: $("AXValue"),
      identifier: $("AXIdentifier"),
      description: $("AXDescription"),
      title: $("AXTitle"),
      help: $("AXHelp"),
      defaultButton: $("AXDefaultButton"),
      cancelButton: $("AXCancelButton"),
      press: $("AXPress"),
      cancel: $("AXCancel"),
    };
    retainedArrays = [];

    failurePhase = "INPUT";
    const inputHandle = $.NSFileHandle.fileHandleWithStandardInput;
    guardResponseHandle = inputHandle;

    const inputHeader = decodeTransportData(
      readTransportData(inputHandle, 5, "header"),
      $.NSASCIIStringEncoding,
      "header",
    );

    inputTransportStage = "header-length";

    if (!/^[0-9]{5}$/.test(inputHeader)) {
      throw new Error("invalid input frame");
    }

    const inputLength = Number(inputHeader);

    if (
      !Number.isInteger(inputLength) ||
      inputLength < 1 ||
      inputLength > 16_384
    ) {
      throw new Error("invalid input frame length");
    }

    const payloadData = readTransportData(inputHandle, inputLength, "payload");
    inputTransportStage = "payload-count";
    const payloadByteCount = Number(payloadData.length);

    if (
      !Number.isSafeInteger(payloadByteCount) ||
      payloadByteCount < 0 ||
      payloadByteCount > 16_384
    ) {
      throw new Error("invalid input payload byte count");
    }

    inputPayloadByteCount = payloadByteCount;

    const payloadText = decodeTransportData(
      payloadData,
      $.NSUTF8StringEncoding,
      "payload",
    );

    inputTransportStage = "payload-parse";
    const payload = JSON.parse(payloadText);
    inputTransportStage = "schema";
    const targetPath = payload.targetPath;

    if (
      targetPath !== null &&
      targetPath !== undefined &&
      Object.getPrototypeOf(targetPath) === String.prototype &&
      targetPath.length <= 4096
    ) {
      inputTargetPathLength = targetPath.length;
    }

    if (
      !["select", "cancel"].includes(mode) ||
      !Number.isInteger(appPID) ||
      appPID < 1 ||
      (mode === "select" &&
        (targetPath === null ||
          targetPath === undefined ||
          Object.getPrototypeOf(targetPath) !== String.prototype ||
          targetPath.length > 4096)) ||
      (mode === "cancel" && targetPath !== null) ||
      Number(payloadData.length) !== inputLength
    ) {
      throw new Error("invalid input");
    }

    failurePhase = "TRUST";
    currentHelperPID = Number($.NSProcessInfo.processInfo.processIdentifier);

    const options = $.NSDictionary.dictionaryWithObjectForKey(
      $.NSNumber.numberWithBool(promptRequested),
      $.kAXTrustedCheckOptionPrompt,
    );

    const trusted = $.AXIsProcessTrustedWithOptions(options);

    if (![true, false, 0, 1].includes(trusted)) {
      throw new Error("untrusted client result type");
    }

    currentClientTrusted = trusted === true || trusted === 1;

    if (!currentClientTrusted) {
      throw new Error("untrusted client");
    }

    failurePhase = "APPLICATION";
    expectedAXPID = appPID;
    failureCode = "application-create-call-failed";

    const application = $.AXUIElementCreateApplication(appPID);

    if (!application) {
      failureCode = "application-element-null";
      throw new Error("application element unavailable");
    }

    failureCode = null;
    assertOwnedElement(application);

    failurePhase = "WINDOWS";
    const copiedWindows = copyAttribute(application, AX.windows, "pointer");

    if (copiedWindows.status !== Number($.kAXErrorSuccess)) {
      windowsAttributeAXErrorStatus = copiedWindows.status;
    }

    if (copiedWindows.status === Number($.kAXErrorNoValue)) {
      failureCode = "windows-attribute-no-value";
      throw new Error("application windows attribute has no value");
    }

    if (copiedWindows.status === Number($.kAXErrorAttributeUnsupported)) {
      failureCode = "windows-attribute-unsupported";
      throw new Error("application windows attribute is unsupported");
    }

    if (copiedWindows.status !== Number($.kAXErrorSuccess)) {
      failureCode = "windows-attribute-query-failed";
      throw new Error("application windows attribute query failed");
    }

    const windows = copyArrayValue(copiedWindows);
    windowCount = windows.length;

    if (windows.length === 0) {
      failureCode = "windows-empty";
      throw new Error("home window unavailable");
    }

    if (windows.length !== 1) {
      failureCode = "windows-count-not-one";
      throw new Error("home window count");
    }

    homeWindow = windows[0];

    failureCode = null;
    let homeWindowRole;

    try {
      readingHomeWindowRole = true;
      windowRoleFailureStage = "copy";
      homeWindowRole = readStringAttribute(homeWindow, AX.role);
      readingHomeWindowRole = false;
    } catch (error) {
      readingHomeWindowRole = false;

      if (failureCode === null) {
        failureCode = "window-role-query-failed";
      }

      throw error;
    }

    if (homeWindowRole !== "AXWindow") {
      failureCode = "window-role-mismatch";

      if (homeWindowRole === undefined) {
        failureCode = "window-role-query-failed";
      }

      throw new Error("home window role");
    }

    failureCode = null;

    failurePhase = "SHEET";
    sheet = waitForExactSheet(homeWindow, mode === "cancel" ? 2 : 10);
    sheetCount = sheet ? 1 : 0;

    if (!sheet) {
      if (mode === "cancel") {
        failurePhase = "SERIALIZE";

        closeGuardTransport();

        return JSON.stringify({
          status: "no-sheet",
          appPID,
          currentHelperPID,
          currentClientTrusted,
          promptRequested,
          actionCount,
          cleanupStatus: "no-sheet-attached",
        });
      }

      throw new Error("attached sheet unavailable");
    }

    if (mode === "cancel") {
      failurePhase = "CANCEL";
      const canceled = pressUniqueCancel(sheet, homeWindow);
      actionCount += canceled ? 1 : 0;

      if (!canceled) {
        throw new Error("owned sheet cancellation unverified");
      }

      cancelControlStage = "wait-sheet-absence";

      if (!waitForNoAttachedSheets(homeWindow, sheet, 5)) {
        throw new Error("owned sheet cancellation unverified");
      }

      cancelControlStage = null;

      cleanupStatus = "sheet-canceled-and-drained";
      failurePhase = "SERIALIZE";

      closeGuardTransport();

      return JSON.stringify({
        status: "canceled",
        appPID,
        currentHelperPID,
        currentClientTrusted,
        promptRequested,
        actionCount,
        cleanupStatus,
      });
    }

    failurePhase = "DISCOVER";
    const elements = descendants(sheet, homeWindow);
    roleCounts = countRoles(elements);

    const textFields = elements.filter(
      (element) => readStringAttribute(element, AX.role) === "AXTextField",
    );

    const settableTextFields = textFields.filter((element) =>
      isAttributeSettable(element, AX.value),
    );

    const pathFields = settableTextFields.filter((element) =>
      isPathSemantic(element),
    );

    textFieldCount = textFields.length;
    settableTextFieldCount = settableTextFields.length;
    semanticPathFieldCount = pathFields.length;

    if (pathFields.length !== 1) {
      throw new Error("unique semantic path field unavailable");
    }

    const openButtons = buttonsFromAttributes(
      elements,
      [sheet, homeWindow],
      AX.defaultButton,
    );

    defaultActionCount = openButtons.length;

    if (openButtons.length !== 1) {
      throw new Error("unique default action unavailable");
    }

    failurePhase = "SET_VALUE";

    authorizeMutation(pathFields[0], sheet, homeWindow, "set-value");

    const setResult = Number(
      $.AXUIElementSetAttributeValue(
        pathFields[0],
        AX.value,
        $.NSString.stringWithString(targetPath),
      ),
    );

    if (setResult !== Number($.kAXErrorSuccess)) {
      throw new Error("path field value rejected");
    }

    if (readStringAttribute(pathFields[0], AX.value) !== targetPath) {
      throw new Error("path field value not retained");
    }

    failurePhase = "PRESS_OPEN";
    performPress(openButtons[0], sheet, homeWindow, "press-open");
    actionCount++;
    failurePhase = "SHEET_DRAIN";

    if (!waitForNoAttachedSheets(homeWindow, sheet, 10)) {
      throw new Error("open sheet remained attached");
    }

    sheet = undefined;
    sheetCount = 0;
    cleanupStatus = "sheet-dismissed";
    failurePhase = "SERIALIZE";

    closeGuardTransport();

    return JSON.stringify({
      status: "selected",
      appPID,
      currentHelperPID,
      currentClientTrusted,
      promptRequested,
      windowCount,
      sheetCount,
      textFieldCount,
      settableTextFieldCount,
      semanticPathFieldCount,
      defaultActionCount,
      pathFieldRole: "AXTextField",
      pathValueMatched: true,
      actionCount,
      cleanupStatus,
      roleCounts,
    });
  } catch {
    const primaryFailureCode = failureCode;
    let finalFailureCode = primaryFailureCode;

    const primaryInputPayloadByteCount =
      failurePhase === "INPUT" ? inputPayloadByteCount : null;

    const primaryInputTargetPathLength =
      failurePhase === "INPUT" ? inputTargetPathLength : null;

    const primaryInputTransportStage =
      failurePhase === "INPUT" ? inputTransportStage : null;

    const primaryTypeIdDiagnostic = typeIdDiagnostic;
    const primaryPidQueryStatus = pidQueryStatus;
    const primaryWindowRoleFailureStage = windowRoleFailureStage;
    const primaryWindowRoleAXErrorStatus = windowRoleAXErrorStatus;
    const primaryWindowsAttributeAXErrorStatus = windowsAttributeAXErrorStatus;
    const primaryPidMismatchDiagnostic = pidMismatchDiagnostic;
    const primaryPanelPidMismatchDiagnostic = panelPidMismatchDiagnostic;
    const primarySheetPIDRelation = sheetPIDRelation;

    const primaryArrayQueryDiagnostic =
      primaryFailureCode === "ax-array-status-failed" &&
      ["DISCOVER", "CANCEL"].includes(failurePhase)
        ? arrayQueryDiagnostic
        : null;

    const primaryCancelCandidateCount =
      failurePhase === "CANCEL" ? cancelCandidateCount : null;

    const primaryCancelControlStage =
      failurePhase === "CANCEL" ? cancelControlStage : null;

    const primaryCancelReferenceDiagnostic =
      failurePhase === "CANCEL" ? { ...cancelReferenceDiagnostic } : null;

    const primaryGuardTransportStage = guardTransportStage;

    if (sheet && homeWindow) {
      cleanupInProgress = true;

      try {
        cleanupStatus = cancelExactSheet(homeWindow, sheet)
          ? "sheet-canceled-and-drained"
          : "unverified";
      } catch {
        cleanupStatus = "unverified";
      }
    }

    try {
      closeGuardTransport();
    } catch {
      finalFailureCode = primaryFailureCode || "panel-guard-failed";
    }

    return JSON.stringify({
      status: "failed",
      appPID,
      currentHelperPID,
      currentClientTrusted,
      promptRequested,
      failurePhase,
      failureCode: finalFailureCode,
      inputTransportStage: primaryInputTransportStage,
      inputPayloadByteCount: primaryInputPayloadByteCount,
      inputTargetPathLength: primaryInputTargetPathLength,
      sheetPIDRelation: primarySheetPIDRelation,
      cancelCandidateCount: primaryCancelCandidateCount,
      cancelControlStage: primaryCancelControlStage,
      cancelReferenceDiagnostic: primaryCancelReferenceDiagnostic,
      cancelMutationAttemptCount,
      guardTransportStage: primaryGuardTransportStage,
      typeIdDiagnostic: primaryTypeIdDiagnostic,
      pidQueryStatus: primaryPidQueryStatus,
      windowRoleFailureStage: primaryWindowRoleFailureStage,
      windowRoleAXErrorStatus: primaryWindowRoleAXErrorStatus,
      windowsAttributeAXErrorStatus: primaryWindowsAttributeAXErrorStatus,
      pidMismatchDiagnostic: primaryPidMismatchDiagnostic,
      panelPidMismatchDiagnostic: primaryPanelPidMismatchDiagnostic,
      arrayQueryDiagnostic: primaryArrayQueryDiagnostic,
      actionCount,
      windowCount,
      sheetCount,
      textFieldCount,
      settableTextFieldCount,
      semanticPathFieldCount,
      defaultActionCount,
      cleanupStatus,
      roleCounts,
    });
  }
}

function ensureGuardTransport() {
  if (guardRequestHandle && guardResponseHandle) {
    return;
  }

  failureCode = "panel-guard-failed";
  guardTransportStage = "transport-init";

  if (!guardRequestHandle) {
    guardRequestHandle =
      $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
  }

  if (!guardResponseHandle) {
    guardResponseHandle = $.NSFileHandle.fileHandleWithStandardInput;
  }

  if (!guardRequestHandle || !guardResponseHandle) {
    throw new Error("Panel guard transport unavailable");
  }

  guardTransportStage = null;
}

function sendGuardFrame(value) {
  guardTransportStage = "request-encode";

  const body = JSON.stringify(value);

  if (body.length < 1 || body.length > 1024) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard request bound exceeded");
  }

  const lengthText = String(body.length);
  const frame = `${"0000".slice(lengthText.length)}${lengthText}${body}`;

  const data = $.NSString.stringWithString(frame).dataUsingEncoding(
    $.NSASCIIStringEncoding,
  );

  const error = Ref("id");

  failureCode = "panel-guard-failed";
  guardTransportStage = "request-write";

  const written = guardRequestHandle.writeDataError(data, error);

  if (written !== true && written !== 1) {
    throw new Error("Panel guard request write failed");
  }

  guardTransportStage = null;
}

function readGuardBytes(length, stage) {
  guardTransportStage = stage;

  return decodeTransportData(
    readTransportData(guardResponseHandle, length),
    $.NSASCIIStringEncoding,
  );
}

function readTransportData(handle, length, segment) {
  failureCode = "panel-guard-failed";

  if (segment) {
    inputTransportStage = `${segment}-buffer-create`;
  }

  const output = $.NSMutableData.alloc.init;
  let received = 0;

  while (received < length) {
    if (segment) {
      inputTransportStage = `${segment}-ref-create`;
    }

    const error = Ref("id");

    if (segment) {
      inputTransportStage = `${segment}-read`;
    }

    const data = handle.readDataUpToLengthError(length - received, error);

    if (!data) {
      throw new Error("Panel guard response read returned no data");
    }

    if (segment) {
      inputTransportStage = `${segment}-count`;
    }

    const chunkLength = Number(data.length);

    if (
      !Number.isSafeInteger(chunkLength) ||
      chunkLength < 1 ||
      chunkLength > length - received
    ) {
      throw new Error("Panel guard response ended early");
    }

    if (segment) {
      inputTransportStage = `${segment}-append`;
    }

    output.appendData(data);
    received += chunkLength;
  }

  return output;
}

function decodeTransportData(data, encoding, segment) {
  if (segment) {
    inputTransportStage = `${segment}-decode`;
  }

  const value = ObjC.unwrap(
    $.NSString.alloc.initWithDataEncoding(data, encoding),
  );

  if (Object.getPrototypeOf(value) !== String.prototype) {
    failureCode = "panel-guard-failed";
    throw new Error("Transport encoding invalid");
  }

  return value;
}

function receiveGuardFrame() {
  const header = readGuardBytes(4, "response-header");

  if (!/^[0-9]{4}$/.test(header)) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard response frame invalid");
  }

  const length = Number(header);

  if (!Number.isInteger(length) || length < 1 || length > 1024) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard response bound exceeded");
  }

  const body = readGuardBytes(length, "response-body");
  guardTransportStage = "response-parse";

  const response = JSON.parse(body);

  guardTransportStage = "response-schema";

  const expectedKeys = [
    "birthMicroseconds",
    "birthSeconds",
    "errorCode",
    "requestId",
    "targetPid",
    "verified",
    "version",
  ];

  if (
    !response ||
    Object.getPrototypeOf(response) !== Object.prototype ||
    Object.keys(response).sort().join(",") !== expectedKeys.join(",")
  ) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard response shape invalid");
  }

  return response;
}

function requestPanelAttestation(targetPid, context) {
  ensureGuardTransport();

  if (
    guardRequestCount >= 16 ||
    guardRequestId >= 16 ||
    !Number.isSafeInteger(targetPid) ||
    targetPid < 1 ||
    targetPid > 2_147_483_647 ||
    !["discovery", "set-value", "press-open", "cancel"].includes(context)
  ) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard request invalid");
  }

  const initial = guardRequestCount === 0;

  if (initial && context !== "discovery") {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard discovery order invalid");
  }

  if (!initial && targetPid !== servicePID) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard target changed");
  }

  guardRequestId++;
  guardRequestCount++;
  sendGuardFrame({
    version: 1,
    requestId: guardRequestId,
    targetPid,
    expectedBirthSec: initial ? null : serviceBirthSeconds,
    expectedBirthUsec: initial ? null : serviceBirthMicroseconds,
    context,
  });

  const response = receiveGuardFrame();

  if (
    response.version !== 1 ||
    response.requestId !== guardRequestId ||
    response.targetPid !== targetPid ||
    response.verified !== true ||
    response.errorCode !== null ||
    !Number.isSafeInteger(response.birthSeconds) ||
    response.birthSeconds < 1 ||
    response.birthSeconds > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(response.birthMicroseconds) ||
    response.birthMicroseconds < 0 ||
    response.birthMicroseconds > 999_999 ||
    (!initial &&
      (response.birthSeconds !== serviceBirthSeconds ||
        response.birthMicroseconds !== serviceBirthMicroseconds))
  ) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel process attestation failed");
  }

  if (initial) {
    servicePID = targetPid;
    serviceBirthSeconds = response.birthSeconds;
    serviceBirthMicroseconds = response.birthMicroseconds;
  }

  guardTransportStage = null;
}

function closeGuardTransport() {
  let closeFailed = false;

  for (const handle of [guardRequestHandle, guardResponseHandle]) {
    if (!handle) {
      continue;
    }

    const error = Ref("id");

    try {
      const closed = handle.closeAndReturnError(error);

      if (closed !== true && closed !== 1) {
        closeFailed = true;
      }
    } catch {
      closeFailed = true;
    }
  }

  guardRequestHandle = null;
  guardResponseHandle = null;

  if (closeFailed) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel guard transport close failed");
  }
}

function copyAttribute(element, attribute, outputType) {
  failureCode = "ax-output-ref-create-failed";
  const result = Ref(outputType);

  failureCode = "ax-copy-call-failed";

  const status = Number(
    $.AXUIElementCopyAttributeValue(element, attribute, result),
  );

  let value;

  if (status === Number($.kAXErrorSuccess)) {
    failureCode = "ax-copy-ref-read-failed";
    value = result[0];
  }

  failureCode = null;

  return {
    status,
    value,
  };
}

function isOptionalAttributeMissing(status) {
  return [
    Number($.kAXErrorNoValue),
    Number($.kAXErrorAttributeUnsupported),
  ].includes(status);
}

function assertOwnedElement(element) {
  assertAXElement(element);

  const pid = readElementPID(element);

  if (pid !== expectedAXPID) {
    pidMismatchDiagnostic = {
      expectedPID: expectedAXPID,
      actualPID: pid,
    };
    failureCode = "element-pid-mismatch";
    throw new Error("Accessibility element process ownership mismatch");
  }

  failureCode = null;

  return element;
}

function assertAXElement(element) {
  typeIdDiagnostic = null;

  if (!element) {
    failureCode = "element-null";
    throw new Error("Accessibility element unavailable");
  }

  failureCode = "element-cf-type-call-failed";

  const typeID = Number($.CFGetTypeID(element));

  failureCode = "element-ax-type-call-failed";

  const expectedTypeID = Number($.AXUIElementGetTypeID());

  if (
    safeTypeIdValue(typeID) === null ||
    safeTypeIdValue(expectedTypeID) === null ||
    typeID !== expectedTypeID
  ) {
    typeIdDiagnostic = {
      actualTypeId: safeTypeIdValue(typeID),
      actualKind: typeIdKind(typeID),
      expectedTypeId: safeTypeIdValue(expectedTypeID),
      expectedKind: typeIdKind(expectedTypeID),
    };
    failureCode = "element-type-mismatch";
    throw new Error("Accessibility element type mismatch");
  }

  return element;
}

function readElementPID(element) {
  failureCode = "element-pid-call-failed";
  pidQueryStatus = null;
  const pid = Ref("int");
  const status = Number($.AXUIElementGetPid(element, pid));

  if (status !== Number($.kAXErrorSuccess)) {
    pidQueryStatus = status;
    failureCode = "element-pid-query-failed";
    throw new Error("Accessibility element process query failed");
  }

  const actualPID = Number(pid[0]);

  if (
    !Number.isSafeInteger(actualPID) ||
    actualPID < 1 ||
    actualPID > 2_147_483_647
  ) {
    failureCode = "element-pid-invalid";
    throw new Error("Accessibility element process identifier invalid");
  }

  failureCode = null;

  return actualPID;
}

function assertTreeElement(element) {
  assertAXElement(element);
  const pid = readElementPID(element);

  assertTreePID(pid);

  failureCode = null;

  return pid;
}

function assertTreePID(pid) {
  if (pid === expectedAXPID || (servicePID !== null && pid === servicePID)) {
    return pid;
  }

  panelPidMismatchDiagnostic = {
    expectedPID: servicePID ?? expectedAXPID,
    actualPID: pid,
  };
  failureCode = "panel-element-pid-mismatch";
  throw new Error("Accessibility element is outside the app and panel process");
}

function assertServiceElement(element) {
  assertAXElement(element);
  const pid = readElementPID(element);

  if (servicePID === null || pid !== servicePID) {
    panelPidMismatchDiagnostic = {
      expectedPID: servicePID ?? expectedAXPID,
      actualPID: pid,
    };
    failureCode = "panel-element-pid-mismatch";
    throw new Error(
      "Accessibility element is outside the attested panel service",
    );
  }

  failureCode = null;

  return pid;
}

function safeTypeIdValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function typeIdKind(value) {
  if (!Number.isFinite(value)) {
    return "non-finite";
  }

  if (Number.isSafeInteger(value)) {
    return value < 0 ? "negative" : "safe-integer";
  }

  return Number.isInteger(value) ? "unsafe-integer" : "non-integer";
}

function copyRequiredArrayAttributeUnscoped(element, attribute) {
  const copied = copyAttribute(element, attribute, "pointer");

  if (copied.status !== Number($.kAXErrorSuccess)) {
    throw new Error("Required accessibility array unavailable");
  }

  return copyArrayElements(copied);
}

function copyDescendantChildren(element, expectedSheet, homeWindow) {
  captureElementPathToSheet(element, expectedSheet, homeWindow);

  const role = readStringAttribute(element, AX.role);
  const copied = copyAttribute(element, AX.children, "pointer");

  if (isOptionalAttributeMissing(copied.status)) {
    return [];
  }

  if (
    copied.status !== Number($.kAXErrorSuccess) &&
    Number.isInteger(copied.status) &&
    copied.status >= -2_147_483_648 &&
    copied.status <= 2_147_483_647
  ) {
    let diagnosticRole = null;

    if (role !== null && role !== undefined) {
      diagnosticRole = ALLOWED_ROLES.has(role) ? role : "AXOther";
    }

    arrayQueryDiagnostic = {
      source: "descendant-children",
      status: copied.status,
      role: diagnosticRole,
    };
  }

  const children = copyArrayElements(copied);

  for (const child of children) {
    const childPID = readElementPID(child);
    assertArrayListsChildExactlyOnce(children, child);

    if (childPID !== expectedAXPID) {
      if (servicePID === null) {
        if (serviceDiscoveryAttempted || cleanupInProgress) {
          failureCode = "panel-guard-failed";
          throw new Error("Panel service discovery is not permitted");
        }

        captureElementPathToSheet(element, expectedSheet, homeWindow);
        assertChildListedExactlyOnce(element, child);

        serviceDiscoveryAttempted = true;
        requestPanelAttestation(childPID, "discovery");

        captureElementPathToSheet(element, expectedSheet, homeWindow);
        assertChildListedExactlyOnce(element, child);
      } else if (childPID !== servicePID) {
        assertTreePID(childPID);
      }
    }

    assertTreePID(childPID);
    const parent = copyRequiredElementAttribute(child, AX.parent);

    if (!sameAXElement(parent, element)) {
      failureCode = "panel-child-parent-mismatch";
      throw new Error("Panel child ancestry mismatch");
    }
  }

  return children;
}

function copyArrayValue(copied) {
  return copyArrayElements(copied, assertOwnedElement);
}

function copyArrayElements(copied, validateElement) {
  if (copied.status !== Number($.kAXErrorSuccess)) {
    failureCode = "ax-array-status-failed";
    throw new Error("Accessibility array query failed");
  }

  assertCFArray(copied.value);

  failureCode = "cf-array-count-call-failed";
  const count = Number($.CFArrayGetCount(copied.value));

  if (!Number.isInteger(count) || count < 0 || count > 512) {
    failureCode = "cf-array-count-invalid";
    throw new Error("Accessibility array bound exceeded");
  }

  retainedArrays.push(copied.value);
  const values = [];

  for (let index = 0; index < count; index++) {
    failureCode = "cf-array-element-retrieval-failed";
    const child = $.CFArrayGetValueAtIndex(copied.value, index);

    if (validateElement) {
      values.push(validateElement(child));
    } else {
      values.push(assertAXElement(child));
    }
  }

  failureCode = null;

  return values;
}

function assertCFArray(value) {
  typeIdDiagnostic = null;

  if (!value) {
    failureCode = "cf-array-value-null";
    throw new Error("Accessibility array unavailable");
  }

  failureCode = "cf-array-cf-type-call-failed";
  const typeID = Number($.CFGetTypeID(value));

  failureCode = "cf-array-type-id-call-failed";
  const expectedTypeID = Number($.CFArrayGetTypeID());

  if (
    safeTypeIdValue(typeID) === null ||
    safeTypeIdValue(expectedTypeID) === null ||
    typeID !== expectedTypeID
  ) {
    typeIdDiagnostic = {
      actualTypeId: safeTypeIdValue(typeID),
      actualKind: typeIdKind(typeID),
      expectedTypeId: safeTypeIdValue(expectedTypeID),
      expectedKind: typeIdKind(expectedTypeID),
    };
    failureCode = "cf-array-type-mismatch";
    throw new Error("Accessibility value is not a CFArray");
  }

  typeIdDiagnostic = null;
  failureCode = null;

  return value;
}

function copyElementAttribute(element, attribute) {
  const copied = copyAttribute(element, attribute, "pointer");

  if (isOptionalAttributeMissing(copied.status)) {
    return undefined;
  }

  if (copied.status !== Number($.kAXErrorSuccess)) {
    throw new Error("Accessibility element query failed");
  }

  assertAXElement(copied.value);
  const pid = readElementPID(copied.value);

  assertTreePID(pid);

  return copied.value;
}

function copyRequiredElementAttribute(element, attribute) {
  const copied = copyAttribute(element, attribute, "pointer");

  if (copied.status !== Number($.kAXErrorSuccess)) {
    throw new Error("Required accessibility element unavailable");
  }

  return assertAXElement(copied.value);
}

function readStringAttribute(element, attribute) {
  const copied = copyAttribute(element, attribute, "id");

  if (readingHomeWindowRole && attribute === AX.role) {
    if (copied.status !== Number($.kAXErrorSuccess)) {
      windowRoleFailureStage = "ax-status";
      windowRoleAXErrorStatus = copied.status;
      failureCode = "window-role-query-failed";
    } else {
      windowRoleFailureStage = "unwrap";
    }
  }

  if (isOptionalAttributeMissing(copied.status)) {
    return undefined;
  }

  if (copied.status !== Number($.kAXErrorSuccess)) {
    throw new Error("Accessibility string query failed");
  }

  const value = ObjC.unwrap(copied.value);

  if (value === null || value === undefined) {
    if (readingHomeWindowRole && attribute === AX.role) {
      windowRoleFailureStage = "null-value";
    }

    return undefined;
  }

  if (Object.getPrototypeOf(value) !== String.prototype) {
    if (readingHomeWindowRole && attribute === AX.role) {
      windowRoleFailureStage = "non-string";
    }

    return undefined;
  }

  if (readingHomeWindowRole && attribute === AX.role) {
    windowRoleFailureStage = null;
    failureCode = null;
  }

  return value;
}

function isAttributeSettable(element, attribute) {
  const result = Ref("bool");

  const status = Number(
    $.AXUIElementIsAttributeSettable(element, attribute, result),
  );

  return (
    status === Number($.kAXErrorSuccess) &&
    (result[0] === true || result[0] === 1)
  );
}

function hasAction(element, requestedAction) {
  const actions = Ref("pointer");
  const status = Number($.AXUIElementCopyActionNames(element, actions));

  if (status !== Number($.kAXErrorSuccess)) {
    return false;
  }

  const actionList = assertCFArray(actions[0]);
  retainedArrays.push(actionList);
  failureCode = "cf-array-count-call-failed";
  const count = Number($.CFArrayGetCount(actionList));

  if (!Number.isInteger(count) || count < 0 || count > 64) {
    failureCode = "cf-array-count-invalid";

    return false;
  }

  failureCode = null;

  for (let index = 0; index < count; index++) {
    failureCode = "cf-array-element-retrieval-failed";
    const action = $.CFArrayGetValueAtIndex(actionList, index);

    if (action === null || action === undefined) {
      failureCode = "cf-string-value-null";
      throw new Error("Accessibility action name unavailable");
    }

    failureCode = "cf-string-type-id-call-failed";
    const actionTypeID = Number($.CFGetTypeID(action));
    const expectedStringTypeID = Number($.CFStringGetTypeID());

    if (
      !Number.isSafeInteger(actionTypeID) ||
      actionTypeID <= 0 ||
      !Number.isSafeInteger(expectedStringTypeID) ||
      expectedStringTypeID <= 0
    ) {
      failureCode = "cf-string-type-id-invalid";
      throw new Error("Accessibility action string type unavailable");
    }

    if (actionTypeID !== expectedStringTypeID) {
      failureCode = "cf-string-type-mismatch";
      throw new Error("Accessibility action name is not a CFString");
    }

    failureCode = "cf-string-compare-call-failed";
    const comparison = Number($.CFStringCompare(action, requestedAction, 0));

    if (![-1, 0, 1].includes(comparison)) {
      failureCode = "cf-string-compare-result-invalid";
      throw new Error("Accessibility action comparison invalid");
    }

    failureCode = null;

    if (comparison === 0) {
      return true;
    }
  }

  return false;
}

function performAction(element, requestedAction, sheet, homeWindow, context) {
  if (context === "cancel" && cancelMutationAttemptCount !== 0) {
    return false;
  }

  if (!hasAction(element, requestedAction)) {
    return false;
  }

  authorizeMutation(element, sheet, homeWindow, context);

  if (context === "cancel") {
    cancelMutationAttemptCount = 1;
  }

  return (
    Number($.AXUIElementPerformAction(element, requestedAction)) ===
    Number($.kAXErrorSuccess)
  );
}

function sameAXElement(left, right) {
  const equal = $.CFEqual(left, right);

  return equal === true || equal === 1;
}

function performPress(element, sheet, homeWindow, context) {
  if (!performAction(element, AX.press, sheet, homeWindow, context)) {
    throw new Error("AXPress unavailable");
  }
}

function authorizeMutation(element, expectedSheet, homeWindow, context) {
  if (servicePID !== null) {
    requestPanelAttestation(servicePID, context);
  }

  const sheets = attachedSheets(homeWindow);

  if (sheets.length !== 1 || !sameAXElement(sheets[0], expectedSheet)) {
    failureCode = "panel-guard-failed";
    throw new Error("The attached panel changed before the requested action");
  }

  const capturedChain = captureElementPathToSheet(
    element,
    expectedSheet,
    homeWindow,
  );

  if (servicePID !== null) {
    requestPanelAttestation(servicePID, context);
  }

  const targetPID = readElementPID(element);
  const targetParent = copyRequiredElementAttribute(element, AX.parent);
  const expectedParent = capturedChain[1];

  assertTreePID(targetPID);

  if (!expectedParent || !sameAXElement(targetParent, expectedParent)) {
    failureCode = "panel-guard-failed";
    throw new Error("The requested control changed before the action");
  }

  assertChildListedExactlyOnce(targetParent, element);
}

function captureElementPathToSheet(element, expectedSheet, homeWindow) {
  const chain = [element];
  let current = element;

  for (let depth = 0; depth <= 8; depth++) {
    const currentPID = assertTreeElement(current);

    if (sameAXElement(current, expectedSheet)) {
      if (currentPID !== sheetOwnerPID) {
        failureCode = "panel-guard-failed";
        throw new Error("Attached sheet owner changed");
      }

      const sheetParent = copyRequiredElementAttribute(current, AX.parent);
      assertOwnedElement(sheetParent);

      if (!sameAXElement(sheetParent, homeWindow)) {
        failureCode = "panel-guard-failed";
        throw new Error("The panel detached from the owned project window");
      }

      assertChildListedExactlyOnce(homeWindow, current);
      chain.push(sheetParent);

      return chain;
    }

    const parent = copyRequiredElementAttribute(current, AX.parent);
    assertTreeElement(parent);

    if (chain.some((ancestor) => sameAXElement(ancestor, parent))) {
      failureCode = "panel-guard-failed";
      throw new Error("The panel parent chain contains a cycle");
    }

    assertChildListedExactlyOnce(parent, current);
    chain.push(parent);
    current = parent;
  }

  failureCode = "panel-guard-failed";
  throw new Error("The requested control is outside the attached panel");
}

function assertChildListedExactlyOnce(parent, child) {
  const children = copyRequiredArrayAttributeUnscoped(parent, AX.children);

  assertArrayListsChildExactlyOnce(children, child);
}

function assertArrayListsChildExactlyOnce(children, child) {
  let matches = 0;

  for (const candidate of children) {
    if (sameAXElement(candidate, child)) {
      matches++;
    }
  }

  if (matches !== 1) {
    failureCode = "panel-guard-failed";
    throw new Error("Panel parent does not list the exact child once");
  }
}

function descendants(root, homeWindow) {
  const found = [];
  const pending = [{ element: root, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.shift();

    if (current.depth > 8) {
      continue;
    }

    found.push(current.element);

    if (found.length > 512) {
      failureCode = "panel-descendant-count-exceeded";
      throw new Error("Accessibility hierarchy bound exceeded");
    }

    const children = copyDescendantChildren(current.element, root, homeWindow);

    for (const child of children) {
      pending.push({ element: child, depth: current.depth + 1 });
    }
  }

  return found;
}

function countRoles(elements) {
  const counts = {};

  for (const element of elements) {
    const role = readStringAttribute(element, AX.role);

    if (role) {
      const key = ALLOWED_ROLES.has(role) ? role : "AXOther";
      counts[key] = (counts[key] || 0) + 1;
    }
  }

  return counts;
}

function isPathSemantic(element) {
  const semantics = [
    readStringAttribute(element, AX.identifier),
    readStringAttribute(element, AX.description),
    readStringAttribute(element, AX.title),
    readStringAttribute(element, AX.help),
  ];

  return semantics.some((value) => PATH_SEMANTICS.has(value));
}

function attachedSheets(homeWindow) {
  const homeChildren = copyRequiredArrayAttributeUnscoped(
    homeWindow,
    AX.children,
  );

  const sheets = [];

  for (const element of homeChildren) {
    const pid = readElementPID(element);

    if (pid === expectedAXPID) {
      assertOwnedElement(element);
    } else if (servicePID === null) {
      assertArrayListsChildExactlyOnce(homeChildren, element);

      if (serviceDiscoveryAttempted || cleanupInProgress) {
        failureCode = "panel-guard-failed";
        throw new Error("Panel service discovery is not permitted");
      }

      sheetPIDRelation = "foreign-candidate";
      serviceDiscoveryAttempted = true;

      requestPanelAttestation(pid, "discovery");
    } else if (pid !== servicePID) {
      assertTreePID(pid);
    }

    if (pid !== expectedAXPID) {
      assertServiceElement(element);
    }

    const role = readStringAttribute(element, AX.role);

    if (pid === expectedAXPID && role === "AXSheet") {
      sheetPIDRelation = "owned-app";
    }

    if (pid !== expectedAXPID && role !== "AXSheet") {
      failureCode = "panel-guard-failed";
      throw new Error("A foreign home-window child is not its sheet");
    }

    if (role !== "AXSheet") {
      continue;
    }

    if (sheetOwnerPID !== null && pid !== sheetOwnerPID) {
      failureCode = "panel-guard-failed";
      throw new Error("Attached sheet owner changed");
    }

    const parent = copyRequiredElementAttribute(element, AX.parent);

    if (
      !sameAXElement(parent, homeWindow) ||
      readElementPID(parent) !== expectedAXPID
    ) {
      failureCode = "panel-guard-failed";
      throw new Error("AXSheet parent does not match the owned home window");
    }

    assertArrayListsChildExactlyOnce(homeChildren, element);

    sheetOwnerPID = pid;

    sheets.push(element);
  }

  return sheets;
}

function waitForExactSheet(homeWindow, seconds) {
  const deadline = Date.now() + seconds * 1_000;

  while (Date.now() <= deadline) {
    const sheets = attachedSheets(homeWindow);

    if (sheets.length > 1) {
      failureCode = "panel-guard-failed";
      throw new Error("multiple attached sheets");
    }

    if (sheets.length === 1) {
      return sheets[0];
    }

    $.NSThread.sleepForTimeInterval(0.1);
  }

  return undefined;
}

function waitForNoAttachedSheets(homeWindow, expectedSheet, seconds) {
  const deadline = Date.now() + seconds * 1_000;

  while (Date.now() <= deadline) {
    const sheets = attachedSheets(homeWindow);

    if (sheets.length === 0) {
      return true;
    }

    if (sheets.length !== 1 || !sameAXElement(sheets[0], expectedSheet)) {
      return false;
    }

    $.NSThread.sleepForTimeInterval(0.1);
  }

  return false;
}

function buttonsFromAttributes(
  elements,
  owners,
  attribute,
  diagnostic,
  ownerContext,
) {
  const references = [];
  let appOwnerAttributePresentCount = 0;

  const sheetOwnerKnown =
    ownerContext &&
    ["owned-app", "foreign-candidate"].includes(ownerContext.sheetPIDRelation);

  let serviceOwnerAttributePresentCount = sheetOwnerKnown ? 0 : null;

  for (const owner of owners) {
    const button = copyElementAttribute(owner, attribute);

    if (diagnostic && button) {
      if (
        owner === ownerContext.homeWindow ||
        (owner === ownerContext.sheet &&
          ownerContext.sheetPIDRelation === "owned-app")
      ) {
        appOwnerAttributePresentCount += 1;
      } else if (
        owner === ownerContext.sheet &&
        ownerContext.sheetPIDRelation === "foreign-candidate"
      ) {
        serviceOwnerAttributePresentCount += 1;
      }
    }

    if (
      button &&
      !references.some((reference) => sameAXElement(reference, button))
    ) {
      references.push(button);
    }
  }

  if (diagnostic) {
    diagnostic.appOwnerAttributePresentCount = appOwnerAttributePresentCount;
    diagnostic.serviceOwnerAttributePresentCount =
      serviceOwnerAttributePresentCount;
    diagnostic.uniqueReferenceCount = references.length;
  }

  let listedReferenceMatchCount = 0;
  let buttonRoleMatchCount = 0;
  let pressActionMatchCount = 0;

  const buttons = elements.filter((element) => {
    if (!references.some((button) => sameAXElement(element, button))) {
      return false;
    }

    listedReferenceMatchCount += 1;

    if (readStringAttribute(element, AX.role) !== "AXButton") {
      return false;
    }

    buttonRoleMatchCount += 1;

    if (!hasAction(element, AX.press)) {
      return false;
    }

    pressActionMatchCount += 1;

    return true;
  });

  if (diagnostic) {
    diagnostic.listedReferenceMatchCount = listedReferenceMatchCount;
    diagnostic.buttonRoleMatchCount = buttonRoleMatchCount;
    diagnostic.pressActionMatchCount = pressActionMatchCount;
  }

  return buttons;
}

function pressUniqueCancel(sheet, homeWindow) {
  cancelControlStage = "collect-controls";

  if (cancelMutationAttemptCount !== 0) {
    return false;
  }

  const elements = descendants(sheet, homeWindow);

  cancelControlStage = "resolve-control";

  const cancelButtons = buttonsFromAttributes(
    elements,
    [sheet, homeWindow],
    AX.cancelButton,
    cancelReferenceDiagnostic,
    {
      homeWindow,
      sheet,
      sheetPIDRelation,
    },
  );

  cancelCandidateCount = cancelButtons.length;

  if (cancelButtons.length !== 1) {
    if (cancelButtons.length !== 0) {
      return false;
    }

    cancelControlStage = "resolve-sheet-action";

    if (!hasAction(sheet, AX.cancel)) {
      return false;
    }

    cancelControlStage = "perform-sheet-action";

    return performAction(sheet, AX.cancel, sheet, homeWindow, "cancel");
  }

  cancelControlStage = "press-control";

  return performAction(cancelButtons[0], AX.press, sheet, homeWindow, "cancel");
}

function cancelExactSheet(homeWindow, expectedSheet) {
  const sheets = attachedSheets(homeWindow);

  if (sheets.length === 0) {
    return true;
  }

  if (sheets.length !== 1 || !sameAXElement(sheets[0], expectedSheet)) {
    return false;
  }

  if (cancelMutationAttemptCount !== 0) {
    return waitForNoAttachedSheets(homeWindow, expectedSheet, 5);
  }

  const actionSucceeded = pressUniqueCancel(sheets[0], homeWindow);

  if (cancelMutationAttemptCount !== 0) {
    const sheetDrained = waitForNoAttachedSheets(homeWindow, expectedSheet, 5);

    return actionSucceeded && sheetDrained;
  }

  return false;
}
