import WebSocket from "ws";
const TOKEN = "6af9912bece4b43f8eca8d7585749574";
const TARGET = "7166dcbe-7770-49a0-af5f-8e6107febdae";
const ws = new WebSocket(`ws://localhost:3847?token=${TOKEN}&session=${TARGET}`);
let msgs = [];
ws.on("message", (data) => {
  const ev = JSON.parse(data.toString());
  if (ev.type === "delta" && ev.content?.startsWith("__USER__")) msgs.push("USER: " + ev.content.slice(8, 60));
  if (ev.type === "delta" && !ev.content?.startsWith("__USER__")) msgs.push("ASST: " + ev.content.slice(0, 60));
  if (ev.type === "history_end") {
    console.log("Session history for 7166dcbe:");
    msgs.slice(-10).forEach(m => console.log(" ", m));
    ws.close(); process.exit(0);
  }
});
ws.on("error", e => { console.error("err:", e.message); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 10000);
