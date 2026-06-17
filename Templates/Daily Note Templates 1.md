<%*
try {
    // 1. 파일 제목(YYYY-MM-DD)에서 날짜 정보 추출
    // tp.file.title이 "2026-01-20" 형태라고 가정합니다.
    const fileTitle = tp.file.title;
    
    // 날짜 형식이 맞는지 체크 (정규식: YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(fileTitle)) {
        console.log("파일 제목이 YYYY-MM-DD 형식이 아닙니다. 이동을 중단합니다.");
        return;
    }

    const dateParts = fileTitle.split("-");
    const year = dateParts[0];
    const month = dateParts[1];
    const day = parseInt(dateParts[2]);

    // 2. 15일 기준으로 상반기/하반기 결정
    //const subFolder = (day <= 15) ? `${year}.${month} 상반기` : `${year}.${month} 하반기`;

    // 3. 최종 경로 설정
    const targetFolder = `Tasks/${year}/${year}.${month}`;

    // 4. 폴더 존재 여부 확인 후 생성
    const folderExists = app.vault.getAbstractFileByPath(targetFolder);
    if (!folderExists) {
        await app.vault.createFolder(targetFolder);
        console.log(`폴더 생성됨: ${targetFolder}`);
    }

    // 5. 파일 이동 처리
    // 목적지 경로: targetFolder/2026-01-20.md
    const newPath = `${targetFolder}/${fileTitle}`;
    const targetFileExists = app.vault.getAbstractFileByPath(newPath);

    if (tp.file.path === newPath) {
        console.log("이미 올바른 위치에 있습니다.");
    } else if (targetFileExists) {
        // 중요: 목적지에 이미 파일이 있다면 이동하지 않고 경고만 출력 (에러 방지)
        console.error(`이동 실패: ${newPath} 위치에 이미 파일이 존재합니다.`);
    } else {
        await tp.file.move(newPath);
        console.log(`파일 이동 완료: ${newPath}`);
    }
tR += `---
create: ${fileTitle}
tags: 
---
`;
} catch (err) {
    console.error("Templater Script Error:", err);
}
%> ---
# {{date}}  
- [ ] 



---  
# 작은 할일
```tasks  
path includes Tasks
status.type is not ON_HOLD
not done  
created before {{date}}
short mode
```

---
# {{date}} 완료
```tasks
path includes Tasks
done on {{date}}
short mode
```  
[[{{yesterday}}|< yesterday]] | [[{{tomorrow}}|tomorrow >]]  





















# 큰 할일
```tasks  
path includes Tasks
status.type is ON_HOLD
created before {{date}}
short mode
```
