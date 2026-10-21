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

const LEAF_ROLES = new Set([
  "AXButton",
  "AXCheckBox",
  "AXImage",
  "AXIncrementor",
  "AXMenuButton",
  "AXPopUpButton",
  "AXProgressIndicator",
  "AXRadioButton",
  "AXSecureTextField",
  "AXSlider",
  "AXStaticText",
  "AXTextArea",
  "AXTextField",
  "AXTokenField",
  "AXValueIndicator",
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
    ObjC.bindFunction("AXUIElementGetPid", ["int", ["pointer", "pointer"]]);
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
    };
    retainedArrays = [];

    failurePhase = "INPUT";
    const inputHandle = $.NSFileHandle.fileHandleWithStandardInput;
    const payloadData = inputHandle.readDataToEndOfFile;

    const payloadText = ObjC.unwrap(
      $.NSString.alloc.initWithDataEncoding(
        payloadData,
        $.NSUTF8StringEncoding,
      ),
    );

    const payload = JSON.parse(payloadText);
    const targetPath = payload.targetPath;

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
      Number(payloadData.length) > 16_384
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
    const copiedWindows = copyAttribute(application, AX.windows);

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

      if (!canceled || !waitForNoAttachedSheets(homeWindow, 5)) {
        throw new Error("owned sheet cancellation unverified");
      }

      cleanupStatus = "sheet-canceled-and-drained";
      failurePhase = "SERIALIZE";

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
    const elements = descendants(sheet);
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
    performPress(openButtons[0]);
    actionCount++;
    failurePhase = "SHEET_DRAIN";

    if (!waitForNoAttachedSheets(homeWindow, 10)) {
      throw new Error("open sheet remained attached");
    }

    sheet = undefined;
    sheetCount = 0;
    cleanupStatus = "sheet-dismissed";
    failurePhase = "SERIALIZE";

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
    const primaryTypeIdDiagnostic = typeIdDiagnostic;
    const primaryPidQueryStatus = pidQueryStatus;
    const primaryWindowRoleFailureStage = windowRoleFailureStage;
    const primaryWindowRoleAXErrorStatus = windowRoleAXErrorStatus;

    if (sheet && homeWindow) {
      try {
        cleanupStatus = cancelExactSheet(homeWindow, sheet)
          ? "sheet-canceled-and-drained"
          : "unverified";
      } catch {
        cleanupStatus = "unverified";
      }
    }

    return JSON.stringify({
      status: "failed",
      appPID,
      currentHelperPID,
      currentClientTrusted,
      promptRequested,
      failurePhase,
      failureCode: primaryFailureCode,
      typeIdDiagnostic: primaryTypeIdDiagnostic,
      pidQueryStatus: primaryPidQueryStatus,
      windowRoleFailureStage: primaryWindowRoleFailureStage,
      windowRoleAXErrorStatus: primaryWindowRoleAXErrorStatus,
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

function copyAttribute(element, attribute) {
  failureCode = "ax-output-ref-create-failed";
  const result = Ref();

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

  failureCode = "element-pid-call-failed";

  pidQueryStatus = null;
  const pid = Ref("int");
  const status = Number($.AXUIElementGetPid(element, pid));

  if (status !== Number($.kAXErrorSuccess)) {
    pidQueryStatus = status;
    failureCode = "element-pid-query-failed";
    throw new Error("Accessibility element process query failed");
  }

  if (Number(pid[0]) !== expectedAXPID) {
    failureCode = "element-pid-mismatch";
    throw new Error("Accessibility element process ownership mismatch");
  }

  failureCode = null;

  return element;
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

function copyRequiredArrayAttribute(element, attribute) {
  const copied = copyAttribute(element, attribute);

  if (copied.status !== Number($.kAXErrorSuccess)) {
    throw new Error("Required accessibility array unavailable");
  }

  return copyArrayValue(copied);
}

function copyDescendantChildren(element) {
  const role = readStringAttribute(element, AX.role);
  const copied = copyAttribute(element, AX.children);

  if (isOptionalAttributeMissing(copied.status) && LEAF_ROLES.has(role)) {
    return [];
  }

  return copyArrayValue(copied);
}

function copyArrayValue(copied) {
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
    values.push(assertOwnedElement(child));
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
  const copied = copyAttribute(element, attribute);

  if (isOptionalAttributeMissing(copied.status)) {
    return undefined;
  }

  if (copied.status !== Number($.kAXErrorSuccess)) {
    throw new Error("Accessibility element query failed");
  }

  return assertOwnedElement(copied.value);
}

function copyRequiredElementAttribute(element, attribute) {
  const copied = copyAttribute(element, attribute);

  if (copied.status !== Number($.kAXErrorSuccess)) {
    throw new Error("Required accessibility element unavailable");
  }

  return assertOwnedElement(copied.value);
}

function readStringAttribute(element, attribute) {
  const copied = copyAttribute(element, attribute);

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
  const result = Ref();

  const status = Number(
    $.AXUIElementIsAttributeSettable(element, attribute, result),
  );

  return (
    status === Number($.kAXErrorSuccess) &&
    (result[0] === true || result[0] === 1)
  );
}

function hasPressAction(element) {
  const actions = Ref();
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
    failureCode = "cf-array-action-name-read-failed";
    const actionName = ObjC.unwrap(action);
    failureCode = null;

    if (actionName === "AXPress") {
      return true;
    }
  }

  return false;
}

function press(element) {
  return (
    hasPressAction(element) &&
    Number($.AXUIElementPerformAction(element, AX.press)) ===
      Number($.kAXErrorSuccess)
  );
}

function performPress(element) {
  if (!press(element)) {
    throw new Error("AXPress unavailable");
  }
}

function descendants(root) {
  const found = [];
  const pending = [{ element: root, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.shift();

    if (current.depth > 8) {
      continue;
    }

    found.push(current.element);

    if (found.length > 512) {
      throw new Error("Accessibility hierarchy bound exceeded");
    }

    const children = copyDescendantChildren(current.element);

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
  const homeChildren = copyRequiredArrayAttribute(homeWindow, AX.children);
  const elements = descendantsWithInitialChildren(homeWindow, homeChildren);
  const sheets = [];

  for (const element of elements) {
    if (readStringAttribute(element, AX.role) !== "AXSheet") {
      continue;
    }

    const parent = copyRequiredElementAttribute(element, AX.parent);

    if (!$.CFEqual(parent, homeWindow)) {
      throw new Error("AXSheet parent does not match the owned home window");
    }

    sheets.push(element);
  }

  return sheets;
}

function descendantsWithInitialChildren(root, initialChildren) {
  const found = [root];
  const pending = initialChildren.map((element) => ({ element, depth: 1 }));

  while (pending.length > 0) {
    const current = pending.shift();

    if (current.depth > 8) {
      continue;
    }

    found.push(current.element);

    if (found.length > 512) {
      throw new Error("Accessibility hierarchy bound exceeded");
    }

    const children = copyDescendantChildren(current.element);

    for (const child of children) {
      pending.push({ element: child, depth: current.depth + 1 });
    }
  }

  return found;
}

function waitForExactSheet(homeWindow, seconds) {
  const deadline = Date.now() + seconds * 1_000;

  while (Date.now() <= deadline) {
    const sheets = attachedSheets(homeWindow);

    if (sheets.length > 1) {
      throw new Error("multiple attached sheets");
    }

    if (sheets.length === 1) {
      return sheets[0];
    }

    $.NSThread.sleepForTimeInterval(0.1);
  }

  return undefined;
}

function waitForNoAttachedSheets(homeWindow, seconds) {
  const deadline = Date.now() + seconds * 1_000;

  while (Date.now() <= deadline) {
    if (attachedSheets(homeWindow).length === 0) {
      return true;
    }

    $.NSThread.sleepForTimeInterval(0.1);
  }

  return false;
}

function buttonsFromAttributes(elements, owners, attribute) {
  const references = [];

  for (const owner of owners) {
    const button = copyElementAttribute(owner, attribute);

    if (
      button &&
      !references.some((reference) => $.CFEqual(reference, button))
    ) {
      references.push(button);
    }
  }

  return elements.filter(
    (element) =>
      references.some((button) => $.CFEqual(element, button)) &&
      readStringAttribute(element, AX.role) === "AXButton" &&
      hasPressAction(element),
  );
}

function pressUniqueCancel(sheet, homeWindow) {
  const cancelButtons = buttonsFromAttributes(
    descendants(sheet),
    [sheet, homeWindow],
    AX.cancelButton,
  );

  return cancelButtons.length === 1 && press(cancelButtons[0]);
}

function cancelExactSheet(homeWindow, expectedSheet) {
  const sheets = attachedSheets(homeWindow);

  if (sheets.length === 0) {
    return true;
  }

  if (sheets.length !== 1 || !$.CFEqual(sheets[0], expectedSheet)) {
    return false;
  }

  return (
    pressUniqueCancel(sheets[0], homeWindow) &&
    waitForNoAttachedSheets(homeWindow, 5)
  );
}
