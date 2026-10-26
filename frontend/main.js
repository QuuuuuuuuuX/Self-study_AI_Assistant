/* 启动入口：依赖 core.js → views-study.js → views-tools.js（加载顺序不可调换）*/
// ---------- 启动 ----------
loadMeta();
showHome();
loadCourses();

window.__appReady = true;
