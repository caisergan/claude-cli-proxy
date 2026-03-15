import { sendMessage } from '../src/index.js';

async function main() {
  const sessionId = "test-session-1";
  console.log(`Sending message to session ${sessionId}...`);
  
  try {
    for await (const event of sendMessage(sessionId, "What is 2+2? Reply with just the number.")) {
      if (event.type === "assistant" && !event.partial) {
        console.log("Claude:", (event.message as any).content);
      }
      if (event.type === "permission_request") {
        console.log("Permission requested for tool:", event.tool);
      }
      if (event.type === "result") {
        console.log("Turn complete. Cost:", event.cost_usd);
        break;
      }
      if (event.type === "error") {
        console.error("Error from Claude:", event.message);
        break;
      }
      if (event.type === "session_closed") {
        console.log("Session closed unexpectedly.");
        break;
      }
    }
  } catch (err) {
    console.error("Caught error:", err);
  } finally {
    console.log("Done. Exiting.");
    process.exit(0);
  }
}

main().catch(console.error);
