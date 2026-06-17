<%*  
try {
const input = await tp.system.prompt(
"정리 문서 날짜 / 문서명 입력 (YYYY-MM-DD / 제목)",
`${tp.date.now("YYYY-MM-DD")} / `
);

if (!input) return;

const parts = input.split("/");

if (parts.length < 2) {
new Notice("형식: YYYY-MM-DD / 문서명");
return;
}

const inputDate = parts[0].trim();
const title = parts.slice(1).join("/").trim();

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
if (!dateRegex.test(inputDate)) {
new Notice("날짜 형식이 YYYY-MM-DD가 아닙니다.");
return;
}

const [year, month, dayStr] = inputDate.split("-");
const day = parseInt(dayStr, 10);

const subFolder = `${year}.${month}.${String(day).padStart(2, "0")}`;
const targetFolder = `Tasks/instance_folder/${year}/${year}.${month}/${subFolder}`;

async function ensureFolder(path) {
const parts = path.split("/");
let current = "";

for (const part of parts) {
current = current ? `${current}/${part}` : part;
if (!app.vault.getAbstractFileByPath(current)) {
await app.vault.createFolder(current);
}
}
}

await ensureFolder(targetFolder);

const safeTitle = title.replace(/[\\/:*?"<>|]/g, "").trim();
const fileName = `${safeTitle}`;
const newPath = `${targetFolder}/${fileName}`;

if (app.vault.getAbstractFileByPath(`${newPath}.md`)) {
new Notice("이미 같은 문서가 있습니다.");
return;
}

await tp.file.move(newPath);

tR += `---
create: ${inputDate}
modified: 
DocNo: 
LinkedDoc:
tags: 
---
`;

new Notice(`문서 생성 완료: ${newPath}.md`);

} catch (err) {
console.error("Templater Script Error:", err);
new Notice("문서 생성 중 오류가 발생했습니다.");
}
%>
# 제목

## 검토

### S1.



## 처리

### E1.

