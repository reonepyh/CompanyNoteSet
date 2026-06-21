const {
  AbstractInputSuggest,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  notesFolder: "Notes",
  attachmentsFolder: "Attachments",
  representativeFrontmatterKey: "",
  documentNumberFormat: "YYYYMMDD-{{seq:5}}",
  createdDateFrontmatterKey: "",
  modifiedDateFrontmatterKey: "",
  frontmatterDateFormat: "YYYY-MM-DD HH:mm",
  assetBaseUrl: "",
  organizeMode: "file",
  attachmentFolderPrefix: "_att_",
  attachmentNumberDigits: 5,
  ignoreHiddenFiles: true,
  ignoreTemporaryFiles: true,
  copyCheckDelayMs: 750,
  autoRunEnabled: false,
  autoRunIntervalMinutes: 30,
  runOnStartup: false,
  startupDelaySeconds: 30,
  autoRunShowNotice: false,
  needsActionFile: "작업필요.md",
  logs: [],
};

const MAX_LOGS = 500;
const STATUS_MOVED = "moved";
const STATUS_SKIPPED = "skipped";
const STATUS_NEEDS_ACTION = "needs-action";
const STATUS_UPDATED = "updated";
const ATTACHMENT_TABLE_HEADING = "## 첨부파일 정리 내역";
const ATTACHMENT_TABLE_HEADER = "| 유형 | 원본 이름 | 변경된 이름 | 변경된 경로 | 처리 시각 |";
const ATTACHMENT_TABLE_SEPARATOR = "| --- | --- | --- | --- | --- |";
const ASSET_LINK_CALLOUT_TITLE = "Asset 링크";
const ASSET_LINK_CALLOUT_HEADER = `> [!info]- ${ASSET_LINK_CALLOUT_TITLE}`;

module.exports = class AttachmentOrganizerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.isRunning = false;
    this.startupTimeoutId = null;
    this.autoRunIntervalId = null;

    this.addCommand({
      id: "run-attachment-organizer",
      name: "첨부파일 정리 실행",
      callback: async () => {
        await this.runCleanup({ showNotice: true, source: "manual" });
      },
    });

    this.addCommand({
      id: "rebuild-asset-link-callouts",
      name: "Asset 링크 콜아웃 재생성",
      callback: async () => {
        const updated = await this.syncAssetLinkCalloutsFromAttachmentTables({ rebuild: true });
        await this.saveSettings();
        new Notice(`Asset 링크 콜아웃 재생성 완료: ${updated}개 문서 갱신`);
      },
    });

    this.addSettingTab(new AttachmentOrganizerSettingTab(this.app, this));
    this.registerAutomaticRuns({ includeStartup: true });
    this.register(() => this.clearAutomaticRuns());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.notesFolder = normalizeVaultPath(this.settings.notesFolder);
    this.settings.attachmentsFolder = normalizeVaultPath(this.settings.attachmentsFolder);
    this.settings.representativeFrontmatterKey = String(this.settings.representativeFrontmatterKey || "").trim();
    this.settings.documentNumberFormat = String(this.settings.documentNumberFormat || DEFAULT_SETTINGS.documentNumberFormat).trim();
    this.settings.createdDateFrontmatterKey = String(this.settings.createdDateFrontmatterKey || "").trim();
    this.settings.modifiedDateFrontmatterKey = String(this.settings.modifiedDateFrontmatterKey || "").trim();
    this.settings.frontmatterDateFormat = String(this.settings.frontmatterDateFormat || DEFAULT_SETTINGS.frontmatterDateFormat).trim();
    this.settings.assetBaseUrl = String(this.settings.assetBaseUrl || "").trim();
    this.settings.organizeMode = this.settings.organizeMode === "folder" ? "folder" : "file";
    this.settings.attachmentFolderPrefix = String(this.settings.attachmentFolderPrefix || DEFAULT_SETTINGS.attachmentFolderPrefix).trim();
    this.settings.attachmentNumberDigits = Number.isInteger(this.settings.attachmentNumberDigits)
      ? this.settings.attachmentNumberDigits
      : DEFAULT_SETTINGS.attachmentNumberDigits;
    this.settings.autoRunEnabled = Boolean(this.settings.autoRunEnabled);
    this.settings.autoRunIntervalMinutes = normalizePositiveInteger(this.settings.autoRunIntervalMinutes, DEFAULT_SETTINGS.autoRunIntervalMinutes, 5);
    this.settings.runOnStartup = Boolean(this.settings.runOnStartup);
    this.settings.startupDelaySeconds = normalizePositiveInteger(this.settings.startupDelaySeconds, DEFAULT_SETTINGS.startupDelaySeconds, 5);
    this.settings.autoRunShowNotice = Boolean(this.settings.autoRunShowNotice);
    this.settings.logs = Array.isArray(this.settings.logs) ? this.settings.logs : [];
  }

  async saveSettings() {
    this.settings.logs = this.settings.logs.slice(0, MAX_LOGS);
    await this.saveData(this.settings);
  }

  registerAutomaticRuns(options = {}) {
    const includeStartup = Boolean(options.includeStartup);
    this.clearAutoRunInterval();
    if (includeStartup) {
      this.clearStartupRun();
    }

    if (includeStartup && this.settings.runOnStartup) {
      this.startupTimeoutId = window.setTimeout(() => {
        this.startupTimeoutId = null;
        this.runCleanup({ showNotice: this.settings.autoRunShowNotice, source: "startup" });
      }, this.settings.startupDelaySeconds * 1000);
    }

    if (this.settings.autoRunEnabled) {
      const intervalMs = this.settings.autoRunIntervalMinutes * 60 * 1000;
      this.autoRunIntervalId = window.setInterval(() => {
        this.runCleanup({ showNotice: this.settings.autoRunShowNotice, source: "auto" });
      }, intervalMs);
    }
  }

  clearAutomaticRuns() {
    this.clearStartupRun();
    this.clearAutoRunInterval();
  }

  clearStartupRun() {
    if (this.startupTimeoutId !== null) {
      window.clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
  }

  clearAutoRunInterval() {
    if (this.autoRunIntervalId !== null) {
      window.clearInterval(this.autoRunIntervalId);
      this.autoRunIntervalId = null;
    }
  }

  async runCleanup(options = {}) {
    const showNotice = options.showNotice !== false;
    const source = options.source || "manual";

    if (this.isRunning) {
      await this.addLog({
        status: STATUS_SKIPPED,
        sourcePath: this.settings.notesFolder,
        reason: `이미 실행 중이라 ${source} 실행 건너뜀`,
      });
      await this.saveSettings();
      if (showNotice) {
        new Notice("첨부파일 정리가 이미 실행 중입니다.");
      }
      return;
    }

    this.isRunning = true;
    try {
      await this.runCleanupInternal({ showNotice, source });
    } catch (error) {
      const message = `첨부파일 정리 실패: ${stringifyError(error)}`;
      if (showNotice || source !== "manual") {
        new Notice(message);
      }
      this.settings.logs = Array.isArray(this.settings.logs) ? this.settings.logs : [];
      await this.addLog({
        status: STATUS_NEEDS_ACTION,
        sourcePath: this.settings.notesFolder,
        reason: "실행 중 오류",
        error: stringifyError(error),
      });
      await this.saveSettings();
    } finally {
      this.isRunning = false;
    }
  }

  async runCleanupInternal(options = {}) {
    const showNotice = options.showNotice !== false;
    if (showNotice) {
      new Notice("첨부파일 정리를 시작합니다.");
    }

    const validation = await this.validateSettings();
    if (!validation.ok) {
      this.settings.logs = [];
      if (showNotice) {
        new Notice(validation.message);
      }
      await this.addLog({
        status: STATUS_NEEDS_ACTION,
        reason: validation.message,
      });
      await this.saveSettings();
      return;
    }

    const summary = {
      moved: 0,
      skipped: 0,
      needsAction: 0,
      frontmatterUpdated: 0,
      assetLinksUpdated: 0,
    };

    this.settings.logs = [];
    this.needsActionEntries = [];
    this.documentNumberOverrides = new Map();

    summary.frontmatterUpdated = await this.fillMissingDocumentFrontmatter();

    if (this.settings.organizeMode === "folder") {
      const result = await this.runFolderBundleCleanup();
      summary.moved += result.moved;
      summary.skipped += result.skipped;
      summary.needsAction += result.needsAction;
    } else {
      const files = this.app.vault
        .getFiles()
        .filter((file) => this.isInsideFolder(file.path, this.settings.notesFolder));
      await this.addLog({
        status: STATUS_SKIPPED,
        sourcePath: this.settings.notesFolder,
        reason: `파일 단위 후보 검사: ${files.length}개`,
      });
      const folderMap = this.groupFilesByFolder(files);

      for (const [folderPath, folderFiles] of folderMap.entries()) {
        const result = await this.processFolder(folderPath, folderFiles);
        summary.moved += result.moved;
        summary.skipped += result.skipped;
        summary.needsAction += result.needsAction;
      }
    }

    summary.assetLinksUpdated = await this.syncAssetLinkCalloutsFromAttachmentTables();

    await this.writeNeedsActionMarkdown();
    await this.saveSettings();
    if (showNotice) {
      new Notice(`첨부파일 정리 완료: 이동 ${summary.moved}개, 제외 ${summary.skipped}개, 작업 필요 ${summary.needsAction}개, 문서 보정 ${summary.frontmatterUpdated}개, Asset 링크 ${summary.assetLinksUpdated}개`);
    }
  }

  async validateSettings() {
    const notesFolder = normalizeVaultPath(this.settings.notesFolder);
    const attachmentsFolder = normalizeVaultPath(this.settings.attachmentsFolder);
    const frontmatterKey = String(this.settings.representativeFrontmatterKey || "").trim();

    if (!notesFolder) {
      return { ok: false, message: "메모 폴더 경로를 입력해 주세요." };
    }

    if (!attachmentsFolder) {
      return { ok: false, message: "첨부파일 폴더 경로를 입력해 주세요." };
    }

    if (!frontmatterKey) {
      return { ok: false, message: "대표 문서 번호 프론트매터 필드명을 입력해 주세요." };
    }

    if (!isVaultRelativePath(notesFolder) || !isVaultRelativePath(attachmentsFolder)) {
      return { ok: false, message: "첨부파일 폴더는 vault 내부 경로만 지정할 수 있습니다." };
    }

    if (notesFolder === attachmentsFolder) {
      return { ok: false, message: "메모 폴더와 첨부파일 폴더는 서로 다른 폴더로 지정해야 합니다." };
    }

    if (this.isInsideFolder(attachmentsFolder, notesFolder) || this.isInsideFolder(notesFolder, attachmentsFolder)) {
      return { ok: false, message: "메모 폴더와 첨부파일 폴더는 서로의 하위 폴더로 지정할 수 없습니다." };
    }

    const notesEntry = this.app.vault.getAbstractFileByPath(notesFolder);
    if (!(notesEntry instanceof TFolder)) {
      return { ok: false, message: "메모 폴더에 접근할 수 없습니다. 폴더 권한을 확인해 주세요." };
    }

    try {
      await this.ensureFolder(attachmentsFolder);
    } catch (error) {
      return { ok: false, message: "첨부파일 폴더에 파일을 저장할 수 없습니다. 폴더 권한을 확인해 주세요." };
    }

    this.settings.notesFolder = notesFolder;
    this.settings.attachmentsFolder = attachmentsFolder;
    this.settings.representativeFrontmatterKey = frontmatterKey;
    this.settings.documentNumberFormat = String(this.settings.documentNumberFormat || DEFAULT_SETTINGS.documentNumberFormat).trim();
    this.settings.attachmentFolderPrefix = this.settings.attachmentFolderPrefix || DEFAULT_SETTINGS.attachmentFolderPrefix;
    this.settings.createdDateFrontmatterKey = String(this.settings.createdDateFrontmatterKey || "").trim();
    this.settings.modifiedDateFrontmatterKey = String(this.settings.modifiedDateFrontmatterKey || "").trim();
    this.settings.frontmatterDateFormat = String(this.settings.frontmatterDateFormat || DEFAULT_SETTINGS.frontmatterDateFormat).trim();
    this.settings.assetBaseUrl = String(this.settings.assetBaseUrl || "").trim();
    await this.saveSettings();

    return { ok: true };
  }

  async fillMissingDocumentFrontmatter() {
    const docNoKey = this.settings.representativeFrontmatterKey;
    const docNoFormat = this.settings.documentNumberFormat;
    const createdKey = this.settings.createdDateFrontmatterKey;
    const modifiedKey = this.settings.modifiedDateFrontmatterKey;

    if (!docNoKey && !createdKey && !modifiedKey) {
      return 0;
    }

    let updatedCount = 0;
    const files = this.app.vault
      .getFiles()
      .filter((file) => this.isInsideFolder(file.path, this.settings.notesFolder))
      .filter((file) => !this.isInsideFolder(file.path, this.settings.attachmentsFolder))
      .filter((file) => file.extension && file.extension.toLowerCase() === "md");

    const usedDocNos = this.collectExistingDocumentNumbers(files, docNoKey);

    for (const file of files) {
      try {
        const changed = await this.fillMissingFrontmatterForFile(file, {
          docNoKey,
          docNoFormat,
          usedDocNos,
          createdKey,
          modifiedKey,
        });
        if (changed) {
          updatedCount += 1;
        }
      } catch (error) {
        await this.recordNeedsAction(file, "프론트매터 보정 실패", { error });
      }
    }

    if (updatedCount > 0) {
      await this.addLog({
        status: STATUS_UPDATED,
        sourcePath: this.settings.notesFolder,
        reason: `프론트매터 필드 보정 ${updatedCount}개`,
      });
    }

    return updatedCount;
  }

  async syncAssetLinkCalloutsFromAttachmentTables(options = {}) {
    const assetBaseUrl = String(this.settings.assetBaseUrl || "").trim();
    const rebuild = Boolean(options.rebuild);

    if (!assetBaseUrl) {
      return 0;
    }

    let updatedCount = 0;
    let tableCount = 0;
    let linkCount = 0;
    const files = this.app.vault
      .getFiles()
      .filter((file) => this.isInsideFolder(file.path, this.settings.notesFolder))
      .filter((file) => !this.isInsideFolder(file.path, this.settings.attachmentsFolder))
      .filter((file) => file.extension && file.extension.toLowerCase() === "md");

    for (const file of files) {
      const content = await this.app.vault.read(file);
      if (!content.split("\n").some((line) => isAttachmentHistoryHeading(line))) {
        continue;
      }

      tableCount += 1;
      linkCount += extractAssetLinkEntriesFromAttachmentTable(content, assetBaseUrl).length;
      const updated = syncAssetLinkCalloutFromAttachmentTable(content, assetBaseUrl, { rebuild });
      if (updated !== content) {
        await this.app.vault.modify(file, updated);
        updatedCount += 1;
      }
    }

    if (updatedCount > 0) {
      await this.addLog({
        status: STATUS_UPDATED,
        sourcePath: this.settings.notesFolder,
        reason: rebuild ? `Asset 링크 콜아웃 재생성 ${updatedCount}개` : `Asset 링크 콜아웃 갱신 ${updatedCount}개`,
      });
    } else {
      await this.addLog({
        status: STATUS_SKIPPED,
        sourcePath: this.settings.notesFolder,
        reason: `Asset 링크 후보 검사: 정리내역 ${tableCount}개, 링크 ${linkCount}개`,
      });
    }

    return updatedCount;
  }

  collectExistingDocumentNumbers(files, docNoKey) {
    const values = new Set();
    if (!docNoKey) {
      return values;
    }

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache && cache.frontmatter ? cache.frontmatter : {};
      const value = normalizeFrontmatterValue(frontmatter[docNoKey]);
      if (value) {
        values.add(value);
      }
    }

    return values;
  }

  async fillMissingFrontmatterForFile(file, options) {
    const { docNoKey, docNoFormat, usedDocNos, createdKey, modifiedKey } = options;
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache && cache.frontmatter ? cache.frontmatter : {};
    const needsDocNo = Boolean(docNoKey) && isEmptyFrontmatterValue(frontmatter[docNoKey]);
    const needsCreated = Boolean(createdKey) && isEmptyFrontmatterValue(frontmatter[createdKey]);
    const needsModified = Boolean(modifiedKey) && isEmptyFrontmatterValue(frontmatter[modifiedKey]);

    if (!needsDocNo && !needsCreated && !needsModified) {
      return false;
    }

    let changed = false;
    const docNoValue = needsDocNo ? this.createDocumentNumber(file, docNoFormat, usedDocNos) : "";
    const createdValue = formatDateWithPattern(new Date(file.stat.ctime), this.settings.frontmatterDateFormat);
    const modifiedValue = formatDateWithPattern(new Date(file.stat.mtime), this.settings.frontmatterDateFormat);

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (needsDocNo && isEmptyFrontmatterValue(frontmatter[docNoKey])) {
        frontmatter[docNoKey] = docNoValue;
        usedDocNos.add(docNoValue);
        this.documentNumberOverrides.set(file.path, docNoValue);
        changed = true;
      }

      if (needsCreated && isEmptyFrontmatterValue(frontmatter[createdKey])) {
        frontmatter[createdKey] = createdValue;
        changed = true;
      }

      if (needsModified && isEmptyFrontmatterValue(frontmatter[modifiedKey])) {
        frontmatter[modifiedKey] = modifiedValue;
        changed = true;
      }
    });

    return changed;
  }

  createDocumentNumber(file, format, usedDocNos) {
    let seq = 1;

    while (true) {
      const value = formatDocumentNumber(file, format, seq);
      if (!usedDocNos.has(value)) {
        return value;
      }
      seq += 1;
    }
  }

  groupFilesByFolder(files) {
    const folderMap = new Map();

    for (const file of files) {
      const folder = parentPath(file.path);
      if (!folderMap.has(folder)) {
        folderMap.set(folder, []);
      }
      folderMap.get(folder).push(file);
    }

    return folderMap;
  }

  async processFolder(folderPath, files) {
    const summary = {
      moved: 0,
      skipped: 0,
      needsAction: 0,
    };
    const attachments = files.filter((file) => !this.shouldIgnoreFile(file));

    if (!attachments.length) {
      summary.skipped += files.length;
      return summary;
    }

    const representatives = this.findRepresentativeFiles(files);

    if (representatives.length === 0) {
      for (const file of attachments) {
        await this.recordNeedsAction(file, "대표 문서 없음", { folderPath });
        summary.needsAction += 1;
      }
      return summary;
    }

    if (representatives.length > 1) {
      await this.recordFolderNeedsAction(folderPath, "대표 문서가 여러 개라 첨부파일 이동 제외");
      summary.needsAction += attachments.length;
      return summary;
    }

    const representative = representatives[0];

    for (const file of attachments) {
      const result = await this.processAttachment(file, representative);
      summary[result] += 1;
    }

    summary.skipped += files.length - attachments.length;
    return summary;
  }

  findRepresentativeFiles(files) {
    const key = this.settings.representativeFrontmatterKey;
    const candidates = files
      .filter((file) => file instanceof TFile && file.extension && file.extension.toLowerCase() === "md")
      .map((file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        const value = cache && cache.frontmatter ? cache.frontmatter[key] : undefined;
        const existingDocNo = normalizeFrontmatterValue(value);
        const generatedDocNo = this.getDocumentNumberOverride(file.path);

        if (existingDocNo) {
          return { file, docNo: existingDocNo, generated: false };
        }

        if (generatedDocNo) {
          return { file, docNo: generatedDocNo, generated: true };
        }

        return null;
      })
      .filter(Boolean);

    const existingCandidates = candidates.filter((candidate) => !candidate.generated);
    const selectedCandidates = existingCandidates.length ? existingCandidates : candidates;
    return selectedCandidates.map((candidate) => ({
      file: candidate.file,
      docNo: candidate.docNo,
    }));
  }

  getDocumentNumberOverride(path) {
    if (!(this.documentNumberOverrides instanceof Map)) {
      return "";
    }

    return normalizeFrontmatterValue(this.documentNumberOverrides.get(path));
  }

  async processAttachment(file, representative) {
    const sourcePath = file.path;
    const originalFilename = pathBasename(sourcePath);
    const copyState = await this.isFileChanging(sourcePath);

    if (copyState.changing) {
      await this.recordNeedsAction(file, "복사 중인 파일");
      return "needsAction";
    }

    if (copyState.error) {
      await this.recordNeedsAction(file, "권한 문제", { error: copyState.error });
      return "needsAction";
    }

    try {
      const targetPath = await this.buildTargetPath(representative.docNo, file);
      await this.app.vault.rename(file, targetPath);
      await this.appendAttachmentTableRow(representative.file, {
        type: "file",
        originalName: originalFilename,
        targetName: pathBasename(targetPath),
        targetPath,
      });
      await this.addLog({
        status: STATUS_MOVED,
        sourcePath,
        targetPath,
        reason: "",
      });
      return "moved";
    } catch (error) {
      await this.recordNeedsActionByPath(sourcePath, "권한 문제", { error });
      return "needsAction";
    }
  }

  async appendAttachmentTableRow(representativeFile, entry) {
    const row = [
      escapeTableCell(entry.type || "file"),
      escapeTableCell(entry.originalName),
      escapeTableCell(entry.targetName),
      escapeTableCell(entry.targetPath),
      formatDate(new Date()),
    ];
    const rowText = `| ${row.join(" | ")} |`;
    const content = await this.app.vault.read(representativeFile);
    let updated = appendRowToMarkdownTable(content, rowText);

    if (this.settings.assetBaseUrl) {
      updated = syncAssetLinkCalloutFromAttachmentTable(updated, this.settings.assetBaseUrl);
    }

    if (updated !== content) {
      await this.app.vault.modify(representativeFile, updated);
    }
  }

  shouldIgnoreFile(file) {
    if (!(file instanceof TFile)) {
      return true;
    }

    if (this.isInsideFolder(file.path, this.settings.attachmentsFolder)) {
      return true;
    }

    if (file.extension && file.extension.toLowerCase() === "md") {
      return true;
    }

    const basename = pathBasename(file.path);
    if (this.settings.ignoreHiddenFiles && basename.startsWith(".")) {
      return true;
    }

    if (this.settings.ignoreTemporaryFiles && isTemporaryFileName(basename)) {
      return true;
    }

    return false;
  }

  async buildTargetPath(docNo, file) {
    await this.ensureFolder(this.settings.attachmentsFolder);

    const safeDocNo = sanitizeFilenameSegment(docNo);
    const extension = getFullExtension(pathBasename(file.path));
    let index = await this.getNextAttachmentIndex(safeDocNo);

    while (true) {
      const attachmentNo = String(index).padStart(this.settings.attachmentNumberDigits, "0");
      const filename = extension ? `${safeDocNo}-${attachmentNo}.${extension}` : `${safeDocNo}-${attachmentNo}`;
      const targetPath = normalizePath(`${this.settings.attachmentsFolder}/${filename}`);

      if (!(await this.app.vault.adapter.exists(targetPath))) {
        return targetPath;
      }

      index += 1;
    }
  }

  async buildTargetFolderPath(docNo) {
    await this.ensureFolder(this.settings.attachmentsFolder);

    const safeDocNo = sanitizeFilenameSegment(docNo);
    let index = await this.getNextAttachmentIndex(safeDocNo);

    while (true) {
      const attachmentNo = String(index).padStart(this.settings.attachmentNumberDigits, "0");
      const targetPath = normalizePath(`${this.settings.attachmentsFolder}/${safeDocNo}-${attachmentNo}`);

      if (!(await this.app.vault.adapter.exists(targetPath))) {
        return targetPath;
      }

      index += 1;
    }
  }

  async getNextAttachmentIndex(safeDocNo) {
    const escaped = escapeRegExp(safeDocNo);
    const pattern = new RegExp(`^${escaped}-(\\d{${this.settings.attachmentNumberDigits},})(?:\\.|$)`);
    let max = 0;

    const files = this.app.vault
      .getAllLoadedFiles()
      .filter((file) => this.isInsideFolder(file.path, this.settings.attachmentsFolder));

    for (const file of files) {
      const match = pathBasename(file.path).match(pattern);
      if (!match) {
        continue;
      }

      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value > max) {
        max = value;
      }
    }

    return max + 1;
  }

  async runFolderBundleCleanup() {
    const summary = {
      moved: 0,
      skipped: 0,
      needsAction: 0,
    };
    const candidates = this.getAttachmentBundleFolders();
    await this.addLog({
      status: STATUS_SKIPPED,
      sourcePath: this.settings.notesFolder,
      reason: `폴더 묶음 후보 검사: ${candidates.length}개`,
    });

    for (const folder of candidates) {
      const result = await this.processAttachmentBundleFolder(folder);
      summary[result] += 1;
    }

    return summary;
  }

  getAttachmentBundleFolders() {
    const prefix = this.settings.attachmentFolderPrefix || DEFAULT_SETTINGS.attachmentFolderPrefix;
    const candidates = this.app.vault
      .getAllLoadedFiles()
      .filter((file) => file instanceof TFolder)
      .filter((folder) => this.isInsideFolder(folder.path, this.settings.notesFolder))
      .filter((folder) => !this.isInsideFolder(folder.path, this.settings.attachmentsFolder))
      .filter((folder) => {
        const name = pathBasename(folder.path);
        return name.startsWith(prefix) && name.length > prefix.length;
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    return candidates.filter((folder, index) => {
      return !candidates.some((other, otherIndex) => {
        return otherIndex !== index && this.isInsideFolder(folder.path, other.path);
      });
    });
  }

  async processAttachmentBundleFolder(folder) {
    const sourcePath = folder.path;
    const sourceName = pathBasename(sourcePath);
    const parentFolder = parentPath(sourcePath);
    const representatives = this.findRepresentativeFiles(this.getFilesDirectlyInFolder(parentFolder));

    if (representatives.length === 0) {
      await this.recordFolderNeedsAction(sourcePath, "대표 문서 없음");
      return "needsAction";
    }

    if (representatives.length > 1) {
      await this.recordFolderNeedsAction(sourcePath, "대표 문서가 여러 개라 첨부파일 이동 제외");
      return "needsAction";
    }

    const representative = representatives[0];

    try {
      const targetPath = await this.buildTargetFolderPath(representative.docNo);
      await this.app.vault.rename(folder, targetPath);
      await this.appendAttachmentTableRow(representative.file, {
        type: "folder",
        originalName: sourceName,
        targetName: pathBasename(targetPath),
        targetPath,
      });
      await this.addLog({
        status: STATUS_MOVED,
        sourcePath,
        targetPath,
        reason: "",
      });
      return "moved";
    } catch (error) {
      await this.recordNeedsActionByPath(sourcePath, "권한 문제", { error });
      return "needsAction";
    }
  }

  getFilesDirectlyInFolder(folderPath) {
    return this.app.vault.getFiles().filter((file) => parentPath(file.path) === folderPath);
  }

  async isFileChanging(path) {
    try {
      const first = await this.app.vault.adapter.stat(path);
      await delay(this.settings.copyCheckDelayMs);
      const second = await this.app.vault.adapter.stat(path);

      if (!first || !second) {
        return { changing: false, error: new Error("파일 상태를 확인할 수 없습니다.") };
      }

      return {
        changing: first.size !== second.size || first.mtime !== second.mtime,
      };
    } catch (error) {
      return { changing: false, error };
    }
  }

  async recordNeedsAction(file, reason, options = {}) {
    await this.recordNeedsActionByPath(file.path, reason, options);
  }

  async recordFolderNeedsAction(folderPath, reason) {
    await this.addLog({
      status: STATUS_NEEDS_ACTION,
      sourcePath: folderPath,
      targetPath: "",
      reason,
    });

    this.addNeedsActionEntry({
      folderPath,
      reason,
    });
  }

  async recordNeedsActionByPath(sourcePath, reason, options = {}) {
    const folderPath = options.folderPath || parentPath(sourcePath);
    const filename = pathBasename(sourcePath);

    await this.addLog({
      status: STATUS_NEEDS_ACTION,
      sourcePath,
      targetPath: "",
      reason,
      error: options.error ? stringifyError(options.error) : "",
    });

    this.addNeedsActionEntry({
      folderPath,
      filename,
      reason,
    });
  }

  addNeedsActionEntry(entry) {
    if (!Array.isArray(this.needsActionEntries)) {
      this.needsActionEntries = [];
    }
    this.needsActionEntries.push(Object.assign({ createdAt: formatDate(new Date()) }, entry));
  }

  async writeNeedsActionMarkdown() {
    const path = normalizeVaultPath(this.settings.needsActionFile || DEFAULT_SETTINGS.needsActionFile);
    try {
      const content = buildNeedsActionMarkdown(this.needsActionEntries || []);
      const exists = await this.app.vault.adapter.exists(path);

      if (!content) {
        if (exists) {
          const existing = this.app.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile) {
            await this.app.vault.delete(existing);
          }
        }
        return;
      }

      if (exists) {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (!(existing instanceof TFile)) {
          throw new Error(`${path} is not a file`);
        }
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(path, content);
      }
    } catch (error) {
      new Notice("작업필요.md 파일을 기록할 수 없습니다. 폴더 권한을 확인해 주세요.");
      await this.addLog({
        status: STATUS_NEEDS_ACTION,
        sourcePath: "",
        targetPath: path,
        reason: "작업필요.md 기록 실패",
        error: stringifyError(error),
      });
    }
  }

  async ensureFolder(path) {
    const normalized = normalizeVaultPath(path);
    if (!normalized) {
      return;
    }

    const segments = normalized.split("/").filter(Boolean);
    let current = "";

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);

      if (existing instanceof TFolder) {
        continue;
      }

      if (existing) {
        throw new Error(`${current} is not a folder`);
      }

      await this.app.vault.createFolder(current);
    }
  }

  isInsideFolder(path, folder) {
    const normalizedPath = normalizeVaultPath(path);
    const normalizedFolder = normalizeVaultPath(folder);
    return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
  }

  async addLog(entry) {
    const log = Object.assign(
      {
        sourcePath: "",
        targetPath: "",
        status: "",
        reason: "",
        error: "",
        createdAt: formatDate(new Date()),
      },
      entry
    );

    this.settings.logs.unshift(log);
    this.settings.logs = this.settings.logs.slice(0, MAX_LOGS);
  }
};

class AttachmentOrganizerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Attachment Organizer" });

    let notesPathPreview;
    new Setting(containerEl)
      .setName("메모 폴더")
      .setDesc("첨부파일 후보를 검사할 vault 내부 폴더입니다.")
      .addText((text) => {
        const applyValue = async (value, updateInput = false) => {
          const normalized = normalizeVaultPath(value);
          this.plugin.settings.notesFolder = normalized;
          if (updateInput) {
            text.setValue(normalized);
          }
          updatePathPreview(notesPathPreview, normalized);
          await this.plugin.saveSettings();
        };

        new FolderSuggest(this.app, text.inputEl, (value) => applyValue(value, true));
        text
          .setPlaceholder("Notes")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(applyValue);
      });
    notesPathPreview = createPathPreview(containerEl, "Vault 기준 경로", this.plugin.settings.notesFolder);

    let attachmentsPathPreview;
    new Setting(containerEl)
      .setName("첨부파일 폴더")
      .setDesc("정리된 첨부파일을 모아둘 vault 내부 단일 폴더입니다.")
      .addText((text) => {
        const applyValue = async (value, updateInput = false) => {
          const normalized = normalizeVaultPath(value);
          this.plugin.settings.attachmentsFolder = normalized;
          if (updateInput) {
            text.setValue(normalized);
          }
          updatePathPreview(attachmentsPathPreview, normalized);
          await this.plugin.saveSettings();
        };

        new FolderSuggest(this.app, text.inputEl, (value) => applyValue(value, true));
        text
          .setPlaceholder("Attachments")
          .setValue(this.plugin.settings.attachmentsFolder)
          .onChange(applyValue);
      });
    attachmentsPathPreview = createPathPreview(containerEl, "Vault 기준 경로", this.plugin.settings.attachmentsFolder);

    new Setting(containerEl)
      .setName("대표 문서 번호 필드")
      .setDesc("대표 Markdown 문서의 프론트매터에서 문서번호를 읽을 필드명입니다.")
      .addText((text) => {
        text
          .setPlaceholder("docNo")
          .setValue(this.plugin.settings.representativeFrontmatterKey)
          .onChange(async (value) => {
            this.plugin.settings.representativeFrontmatterKey = String(value || "").trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("문서번호 형식")
      .setDesc("대표 문서 번호 필드가 비어 있을 때 자동 생성할 형식입니다. 예: YYYYMMDD-{{seq:5}}")
      .addText((text) => {
        text
          .setPlaceholder("YYYYMMDD-{{seq:5}}")
          .setValue(this.plugin.settings.documentNumberFormat)
          .onChange(async (value) => {
            this.plugin.settings.documentNumberFormat = String(value || "").trim() || DEFAULT_SETTINGS.documentNumberFormat;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("생성일 필드")
      .setDesc("비어 있는 경우 파일 생성 시각으로 채울 프론트매터 필드명입니다.")
      .addText((text) => {
        text
          .setPlaceholder("create")
          .setValue(this.plugin.settings.createdDateFrontmatterKey)
          .onChange(async (value) => {
            this.plugin.settings.createdDateFrontmatterKey = String(value || "").trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("수정일 필드")
      .setDesc("비어 있는 경우 파일 수정 시각으로 채울 프론트매터 필드명입니다.")
      .addText((text) => {
        text
          .setPlaceholder("modified")
          .setValue(this.plugin.settings.modifiedDateFrontmatterKey)
          .onChange(async (value) => {
            this.plugin.settings.modifiedDateFrontmatterKey = String(value || "").trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("날짜 형식")
      .setDesc("생성일/수정일 필드에 기록할 날짜 형식입니다.")
      .addText((text) => {
        text
          .setPlaceholder("YYYY-MM-DD HH:mm")
          .setValue(this.plugin.settings.frontmatterDateFormat)
          .onChange(async (value) => {
            this.plugin.settings.frontmatterDateFormat = String(value || "").trim() || DEFAULT_SETTINGS.frontmatterDateFormat;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("웹 Asset 기본 경로")
      .setDesc("Asset 루트까지의 기본 URL입니다. 파일은 download, 폴더는 path 링크로 자동 생성합니다. 비워두면 링크를 만들지 않습니다.")
      .addText((text) => {
        text
          .setPlaceholder("https://asset.livenext.synology.me/index.php?path=WiseneoscoDoc_Asset")
          .setValue(this.plugin.settings.assetBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.assetBaseUrl = String(value || "").trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("정리 모드")
      .setDesc("파일 단위 또는 폴더 묶음 중 하나만 선택해서 실행합니다.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("file", "파일 단위")
          .addOption("folder", "폴더 묶음")
          .setValue(this.plugin.settings.organizeMode)
          .onChange(async (value) => {
            this.plugin.settings.organizeMode = value === "folder" ? "folder" : "file";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Obsidian 시작 시 실행")
      .setDesc("플러그인 로드 후 설정한 지연 시간 뒤에 첨부파일 정리를 1회 실행합니다.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.runOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.runOnStartup = Boolean(value);
            if (!this.plugin.settings.runOnStartup) {
              this.plugin.clearStartupRun();
            }
            await this.plugin.saveSettings();
            this.plugin.registerAutomaticRuns();
          });
      });

    new Setting(containerEl)
      .setName("시작 실행 지연 시간")
      .setDesc("Obsidian 시작 후 자동 실행까지 기다릴 시간입니다. 최소 5초입니다.")
      .addText((text) => {
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.startupDelaySeconds))
          .onChange(async (value) => {
            this.plugin.settings.startupDelaySeconds = normalizePositiveInteger(value, DEFAULT_SETTINGS.startupDelaySeconds, 5);
            await this.plugin.saveSettings();
            this.plugin.registerAutomaticRuns();
          });
      });

    new Setting(containerEl)
      .setName("주기적 자동 실행")
      .setDesc("설정한 간격마다 첨부파일 정리를 자동 실행합니다. 첫 실행은 한 주기 뒤에 시작합니다.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoRunEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoRunEnabled = Boolean(value);
            await this.plugin.saveSettings();
            this.plugin.registerAutomaticRuns();
          });
      });

    new Setting(containerEl)
      .setName("자동 실행 간격")
      .setDesc("주기적 자동 실행 간격입니다. 최소 5분입니다.")
      .addText((text) => {
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.autoRunIntervalMinutes))
          .onChange(async (value) => {
            this.plugin.settings.autoRunIntervalMinutes = normalizePositiveInteger(value, DEFAULT_SETTINGS.autoRunIntervalMinutes, 5);
            await this.plugin.saveSettings();
            this.plugin.registerAutomaticRuns();
          });
      });

    new Setting(containerEl)
      .setName("자동 실행 알림 표시")
      .setDesc("시작 시 실행과 주기적 자동 실행에서도 시작/완료 알림을 표시합니다.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoRunShowNotice)
          .onChange(async (value) => {
            this.plugin.settings.autoRunShowNotice = Boolean(value);
            await this.plugin.saveSettings();
            this.plugin.registerAutomaticRuns();
          });
      });

    new Setting(containerEl)
      .setName("첨부 묶음 폴더 prefix")
      .setDesc("폴더 묶음 모드에서 이 prefix로 시작하고 뒤에 이름이 있는 폴더만 이동합니다.")
      .addText((text) => {
        text
          .setPlaceholder("_att_")
          .setValue(this.plugin.settings.attachmentFolderPrefix)
          .onChange(async (value) => {
            this.plugin.settings.attachmentFolderPrefix = String(value || "").trim() || DEFAULT_SETTINGS.attachmentFolderPrefix;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("실행")
      .setDesc("현재 설정으로 첨부파일 정리를 실행합니다.")
      .addButton((button) => {
        button
          .setButtonText("첨부파일 정리 실행")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("실행 중...");
            try {
              await this.plugin.runCleanup();
            } finally {
              this.display();
            }
          });
      });

    new Setting(containerEl)
      .setName("로그 비우기")
      .setDesc("플러그인 설정 데이터 내부에 저장된 처리 로그를 삭제합니다.")
      .addButton((button) => {
        button
          .setButtonText("로그 비우기")
          .onClick(async () => {
            this.plugin.settings.logs = [];
            await this.plugin.saveSettings();
            this.display();
          });
      });

    containerEl.createEl("h3", { text: "최근 로그" });
    const logEl = containerEl.createDiv({ cls: "attachment-mirroring-log" });

    if (!this.plugin.settings.logs.length) {
      logEl.createEl("span", { text: "로그가 없습니다." });
      return;
    }

    const text = this.plugin.settings.logs
      .slice(0, 20)
      .map((log) => {
        const target = log.targetPath ? ` -> ${log.targetPath}` : "";
        const reason = log.reason ? ` (${log.reason})` : "";
        return `[${log.createdAt}] ${log.status}: ${log.sourcePath}${target}${reason}`;
      })
      .join("\n");

    logEl.createEl("pre", { text });
  }
}

class FolderSuggest extends AbstractInputSuggest {
  constructor(app, inputEl, onSelect) {
    super(app, inputEl);
    this.app = app;
    this.onSelect = onSelect;
  }

  getSuggestions(query) {
    const normalizedQuery = normalizeVaultPath(query).toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file) => file instanceof TFolder)
      .map((folder) => folder.path)
      .filter((path) => path && path.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 50);
  }

  renderSuggestion(path, el) {
    el.setText(path);
  }

  async selectSuggestion(path) {
    await this.onSelect(path);
    this.close();
  }
}

function normalizeVaultPath(value) {
  return normalizePath(String(value || "").trim().replace(/\\/g, "/")).replace(/^\/+/, "").replace(/\/+$/, "");
}

function createPathPreview(containerEl, label, path) {
  const preview = containerEl.createDiv({ cls: "attachment-organizer-path-preview" });
  preview.createSpan({ text: `${label}: ` });
  const codeEl = preview.createEl("code", { text: path || "(미설정)" });
  return codeEl;
}

function updatePathPreview(codeEl, path) {
  if (!codeEl) {
    return;
  }
  codeEl.setText(path || "(미설정)");
}

function normalizePositiveInteger(value, fallback, minimum) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  const safeFallback = Number.isFinite(fallback) ? fallback : minimum;

  if (!Number.isFinite(parsed)) {
    return Math.max(safeFallback, minimum);
  }

  return Math.max(parsed, minimum);
}

function isVaultRelativePath(path) {
  if (!path) {
    return false;
  }

  if (path.startsWith("/") || path.includes("://")) {
    return false;
  }

  if (/^[a-zA-Z]:\//.test(path)) {
    return false;
  }

  return !path.split("/").includes("..");
}

function parentPath(path) {
  const parts = normalizePath(path).split("/");
  parts.pop();
  return parts.join("/");
}

function pathBasename(path) {
  return normalizePath(path).split("/").pop() || "";
}

function getFullExtension(filename) {
  const parts = filename.split(".");
  if (parts.length <= 1 || parts[0] === "") {
    return "";
  }
  return parts.slice(1).join(".");
}

function normalizeFrontmatterValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return "";
  }

  return String(value).trim();
}

function isEmptyFrontmatterValue(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === "string") {
    return value.trim() === "";
  }

  return false;
}

function sanitizeFilenameSegment(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ");
}

function isTemporaryFileName(name) {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("~$") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".temp") ||
    lower.endsWith(".part") ||
    lower.endsWith(".crdownload")
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error) {
  return String(error && error.message ? error.message : error);
}

function appendRowToMarkdownTable(content, rowText) {
  if (!content.includes(ATTACHMENT_TABLE_HEADING)) {
    const suffix = [
      "",
      ATTACHMENT_TABLE_HEADING,
      "",
      ATTACHMENT_TABLE_HEADER,
      ATTACHMENT_TABLE_SEPARATOR,
      rowText,
      "",
    ].join("\n");
    return `${content.trimEnd()}\n${suffix}`;
  }

  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === ATTACHMENT_TABLE_HEADING);
  if (headingIndex === -1) {
    return content;
  }

  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex].trim() === "") {
    insertIndex += 1;
  }

  if (lines[insertIndex] !== ATTACHMENT_TABLE_HEADER || lines[insertIndex + 1] !== ATTACHMENT_TABLE_SEPARATOR) {
    lines.splice(
      headingIndex + 1,
      0,
      "",
      ATTACHMENT_TABLE_HEADER,
      ATTACHMENT_TABLE_SEPARATOR,
      rowText,
      ""
    );
    return lines.join("\n");
  }

  insertIndex += 2;
  while (insertIndex < lines.length && /^\|.*\|$/.test(lines[insertIndex].trim())) {
    insertIndex += 1;
  }

  lines.splice(insertIndex, 0, rowText);
  return lines.join("\n");
}

function upsertAssetLinkCallout(content, entry) {
  return syncAssetLinkCallout(content, [entry]);
}

function syncAssetLinkCalloutFromAttachmentTable(content, assetBaseUrl, options = {}) {
  const entries = extractAssetLinkEntriesFromAttachmentTable(content, assetBaseUrl);
  return syncAssetLinkCallout(content, entries, options);
}

function syncAssetLinkCallout(content, entries, options = {}) {
  const linkLines = [];
  const seen = new Set();

  for (const entry of entries) {
    const label = escapeMarkdownLinkLabel(entry.label || "");
    const url = String(entry.url || "").trim();

    if (!label || !url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    linkLines.push(`> - [${label}](${url})`);
  }

  if (!linkLines.length) {
    return content;
  }

  const lines = content.split("\n");
  const calloutIndex = lines.findIndex((line) => line.trim() === ASSET_LINK_CALLOUT_HEADER);
  const rebuild = Boolean(options.rebuild);

  if (calloutIndex === -1) {
    const suffix = [
      "",
      ASSET_LINK_CALLOUT_HEADER,
      ...linkLines,
      "",
    ].join("\n");
    return `${content.trimEnd()}\n${suffix}`;
  }

  let endIndex = calloutIndex + 1;
  while (endIndex < lines.length && lines[endIndex].startsWith(">")) {
    endIndex += 1;
  }

  if (rebuild) {
    lines.splice(calloutIndex, endIndex - calloutIndex, ASSET_LINK_CALLOUT_HEADER, ...linkLines);
    return lines.join("\n");
  }

  const existingUrls = new Set();
  for (let index = calloutIndex + 1; index < endIndex; index += 1) {
    const url = extractMarkdownLinkUrl(lines[index]);
    if (url) {
      existingUrls.add(url);
    }
  }

  const missingLinkLines = linkLines.filter((line) => {
    const url = extractMarkdownLinkUrl(line);
    return url && !existingUrls.has(url);
  });

  if (!missingLinkLines.length) {
    return content;
  }

  lines.splice(endIndex, 0, ...missingLinkLines);
  return lines.join("\n");
}

function extractMarkdownLinkUrl(line) {
  const match = String(line || "").match(/\[[^\]]*\]\(([^)]+)\)/);
  return match ? match[1].trim() : "";
}

function extractAssetLinkEntriesFromAttachmentTable(content, assetBaseUrl) {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => isAttachmentHistoryHeading(line));

  if (headingIndex === -1) {
    return [];
  }

  let rowIndex = headingIndex + 1;
  while (rowIndex < lines.length && lines[rowIndex].trim() === "") {
    rowIndex += 1;
  }

  while (rowIndex < lines.length && !isMarkdownTableRow(lines[rowIndex])) {
    if (/^#{1,6}\s+/.test(String(lines[rowIndex] || "").trim())) {
      return [];
    }
    rowIndex += 1;
  }

  if (!isMarkdownTableRow(lines[rowIndex])) {
    return [];
  }

  const headerCells = splitMarkdownTableRow(lines[rowIndex]).map((cell) => unescapeTableCell(cell));
  const typeIndex = findTableColumnIndex(headerCells, ["유형", "타입", "종류"]);
  const originalNameIndex = findTableColumnIndex(headerCells, ["원본 이름", "원본 파일명", "원본파일명", "파일명"]);
  const targetNameIndex = findTableColumnIndex(headerCells, ["변경된 이름", "변경 이름", "변경 파일명", "변경된 파일명", "변경된 경로"]);
  const fallbackToCurrentTableShape = originalNameIndex === -1 || targetNameIndex === -1;

  if (fallbackToCurrentTableShape && headerCells.length < 3) {
    return [];
  }

  const entries = [];
  rowIndex += isMarkdownTableSeparator(lines[rowIndex + 1]) ? 2 : 1;

  while (rowIndex < lines.length && isMarkdownTableRow(lines[rowIndex])) {
    const cells = splitMarkdownTableRow(lines[rowIndex]);
    const attachmentType = normalizeAttachmentType(unescapeTableCell(cells[typeIndex] || ""));
    const originalName = unescapeTableCell(cells[fallbackToCurrentTableShape ? 1 : originalNameIndex] || "");
    const targetName = unescapeTableCell(cells[fallbackToCurrentTableShape ? 2 : targetNameIndex] || "");
    const url = buildAssetUrl(assetBaseUrl, targetName, attachmentType);

    if (originalName && targetName && url) {
      entries.push({
        label: originalName,
        url,
      });
    }

    rowIndex += 1;
  }

  return entries;
}

function isAttachmentHistoryHeading(line) {
  const normalized = String(line || "").trim().replace(/\s+/g, " ");
  return /^#{1,6}\s+첨부파일 정리 내역\s*$/.test(normalized);
}

function findTableColumnIndex(cells, names) {
  const normalizedNames = names.map(normalizeTableHeaderName);
  return cells.findIndex((cell) => normalizedNames.includes(normalizeTableHeaderName(cell)));
}

function normalizeTableHeaderName(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function normalizeAttachmentType(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "folder" || normalized === "폴더") {
    return "folder";
  }

  return "file";
}

function isMarkdownTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(String(line || ""));
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ""));
}

function splitMarkdownTableRow(row) {
  const trimmed = String(row || "").trim();
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaping = false;

  for (const char of body) {
    if (escaping) {
      current += `\\${char}`;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  cells.push(current.trim());
  return cells;
}

function buildAssetUrl(baseUrl, targetName, attachmentType = "file") {
  const trimmedBaseUrl = String(baseUrl || "").trim();
  const trimmedTargetName = String(targetName || "").trim();
  const targetParam = attachmentType === "folder" ? "path" : "download";

  if (!trimmedBaseUrl || !trimmedTargetName) {
    return "";
  }

  try {
    const url = new URL(trimmedBaseUrl);
    const existingParam = getAssetPathQueryParam(url);
    if (existingParam) {
      const basePath = url.searchParams.get(existingParam) || "";
      if (existingParam !== targetParam) {
        url.searchParams.delete(existingParam);
      }
      url.searchParams.set(targetParam, joinAssetPath(basePath, trimmedTargetName));
      return url.toString();
    }

    url.pathname = joinUrlPath(url.pathname, trimmedTargetName);
    return url.toString();
  } catch (error) {
    const marker = getAssetPathQueryMarker(trimmedBaseUrl);
    const markerIndex = marker ? trimmedBaseUrl.indexOf(marker) : -1;
    if (markerIndex !== -1) {
      const separator = marker.startsWith("?") ? "?" : "&";
      const prefix = `${trimmedBaseUrl.slice(0, markerIndex)}${separator}${targetParam}=`;
      const basePath = decodeURIComponent(trimmedBaseUrl.slice(markerIndex + marker.length));
      return `${prefix}${encodeURIComponent(joinAssetPath(basePath, trimmedTargetName))}`;
    }

    return `${trimmedBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(trimmedTargetName)}`;
  }
}

function getAssetPathQueryParam(url) {
  if (url.searchParams.has("download")) {
    return "download";
  }

  if (url.searchParams.has("path")) {
    return "path";
  }

  return "";
}

function getAssetPathQueryMarker(url) {
  if (url.includes("?download=")) {
    return "?download=";
  }

  if (url.includes("&download=")) {
    return "&download=";
  }

  if (url.includes("?path=")) {
    return "?path=";
  }

  if (url.includes("&path=")) {
    return "&path=";
  }

  return "";
}

function joinAssetPath(basePath, targetName) {
  return [String(basePath || "").replace(/^\/+|\/+$/g, ""), String(targetName || "").replace(/^\/+|\/+$/g, "")]
    .filter(Boolean)
    .join("/");
}

function joinUrlPath(basePath, targetName) {
  const base = String(basePath || "").replace(/\/+$/, "");
  const encodedTarget = encodeURIComponent(targetName);
  return `${base}/${encodedTarget}`;
}

function escapeTableCell(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function unescapeTableCell(value) {
  return String(value || "")
    .replace(/\\\|/g, "|")
    .replace(/\\\\/g, "\\")
    .trim();
}

function escapeMarkdownLinkLabel(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\]/g, "\\]")
    .replace(/\r?\n/g, " ")
    .trim();
}

function buildNeedsActionMarkdown(entries) {
  if (!entries.length) {
    return "";
  }

  const lines = ["# 작업 필요", ""];

  for (const entry of entries) {
    lines.push(`## ${entry.createdAt || formatDate(new Date())}`, "");
    lines.push(`- 경로: ${entry.folderPath || ""}`);

    if (entry.filename) {
      lines.push(`- 파일: ${entry.filename}`);
    }

    lines.push(`- 사유: ${entry.reason || ""}`, "");
  }

  return `${lines.join("\n")}\n`;
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function formatDateWithPattern(date, pattern) {
  const pad = (value) => String(value).padStart(2, "0");
  const replacements = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };

  return String(pattern || DEFAULT_SETTINGS.frontmatterDateFormat).replace(
    /YYYY|MM|DD|HH|mm|ss/g,
    (token) => replacements[token] || token
  );
}

function formatDocumentNumber(file, pattern, seq) {
  const created = new Date(file.stat.ctime);
  const title = file.basename || pathBasename(file.path).replace(/\.md$/i, "");
  return String(pattern || DEFAULT_SETTINGS.documentNumberFormat)
    .replace(/\{\{seq(?::(\d+))?\}\}/g, (_, digits) => {
      const width = digits ? Number.parseInt(digits, 10) : 1;
      return String(seq).padStart(Number.isFinite(width) && width > 0 ? width : 1, "0");
    })
    .replace(/\{\{title\}\}/g, title)
    .replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => {
      return dateToken(created, token);
    });
}

function dateToken(date, token) {
  const pad = (value) => String(value).padStart(2, "0");
  const replacements = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };

  return replacements[token] || token;
}
