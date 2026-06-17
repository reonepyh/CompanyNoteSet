module.exports = async (tp) => {
    const file = app.workspace.getActiveFile();
    if (!file) return "";

    let content = await app.vault.read(file);

    const headers = content.match(/^#{1,6}\s+.+$/gm) || [];

    // =========================
    // 1. TOC 생성
    // =========================
    let toc = "> [!toc]- 목차\n";

    let stack = [{ level: 0 }];

    for (const header of headers) {
        const level = header.match(/^#+/)[0].length;
        const title = header.replace(/^#+\s+/, "").trim();
        const link = `[[#${title}]]`;

        while (stack.length && stack[stack.length - 1].level >= level) {
            stack.pop();
        }

        stack.push({ level });

        const indent = "  ".repeat(stack.length - 1);

        toc += `> ${indent}- ${link}\n`;
    }

    toc += "\n---\n";

    // =========================
    // 2. 기존 TOC 제거
    // =========================
    const tocRegex =
        /> \[!toc\][\s\S]*?(?=\n#{1,6}|\n$)/g;

    content = content.replace(tocRegex, "").trimStart();

    // =========================
    // 3. H1 위치 찾기 (# Title)
    // =========================
    const lines = content.split("\n");

    let h1Index = lines.findIndex(line => /^#\s+/.test(line));

    // H1 없으면 맨 위
    if (h1Index === -1) {
        h1Index = 0;
    }

    // =========================
    // 4. TOC 삽입
    // =========================
    const before = lines.slice(0, h1Index + 1);
    const after = lines.slice(h1Index + 1);

    const updated = [
        ...before,
        "",
        toc,
        "",
        ...after
    ].join("\n");

    await app.vault.modify(file, updated);

    return "";
};
