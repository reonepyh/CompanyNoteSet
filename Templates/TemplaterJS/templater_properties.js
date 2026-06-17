// 속성 정의 영역
// mode:
// - "insert": 속성이 없을 때만 추가합니다.
// - "upsert": 속성이 있으면 수정하고, 없으면 추가합니다.
const PROPERTY_DEFINITIONS = [
    { key: "create", value: "{{datetime}}", mode: "insert" },
    { key: "modified", value: "{{datetime}}", mode: "upsert" },
    { key: "DocNo", value: "", mode: "insert" },
    { key: "LinkedDoc", value: "", mode: "insert" },
    { key: "tags", value: [], mode: "insert" }
];

module.exports = async (tp) => {
    const file = app.workspace.getActiveFile();
    if (!file) return "";

    const context = createContext(file);
    const properties = PROPERTY_DEFINITIONS.map(property => ({
        ...property,
        value: resolveValue(property.value, context)
    }));

    await app.fileManager.processFrontMatter(file, frontmatter => {
        for (const property of properties) {
            if (property.mode === "insert" && hasProperty(frontmatter, property.key)) {
                continue;
            }

            frontmatter[property.key] = property.value;
        }
    });

    return "";
};

function hasProperty(frontmatter, key) {
    return Object.prototype.hasOwnProperty.call(frontmatter, key);
}

function createContext(file) {
    const now = new Date();

    return {
        date: formatDate(now),
        datetime: formatDateTime(now),
        title: file.basename
    };
}

function resolveValue(value, context) {
    if (typeof value !== "string") return value;

    return value.replace(/\{\{(date|datetime|title)\}\}/g, (_, token) => {
        return context[token] ?? "";
    });
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function formatDateTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");

    return `${year}-${month}-${day} ${hours}:${minutes}`;
}
