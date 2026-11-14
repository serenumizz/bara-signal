// Local test harness: the real Worker with a fake Workers AI binding (D1 and KV are real, local).
import worker from "../src/index.js";
let calls = 0;
const fakeAI = { run: async (model, { messages }) => {
  calls++; const u = messages[1].content;
  if (u.includes("Reply as JSON")) return { response: 'Sure! {"kind":"estuary","ids":["chl","sst","HACKED","swh","chl","runoff"],"note":"Algae and water height respond to river flow."}' };
  return { response: `[fake model #${calls}] ${u.slice(0, 70)}` };
} };
export default { fetch: (req, env, ctx) => worker.fetch(req, { ...env, AI: fakeAI }, ctx) };
