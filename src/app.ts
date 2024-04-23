/**
 * This file is a Slack bot that is simply a historical placeholder for the PolicyWonk project.
 * The `app_llm.ts` file contains the original Slack bot implementation.
 * This bot just responds to mentions and slash commands with a message to go use the https://policywonk.ucdavis.edu website.
 */
import {
  App,
  AckFn,
  RespondArguments,
  SlashCommand,
  RespondFn,
} from "@slack/bolt";
import dotenv from "dotenv";
import { ensureLogIndexExists } from "./logging";

dotenv.config();

let app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// if we have an app token, we want to use it and socket mode
// this is for local development only
if (process.env.SLACK_APP_TOKEN) {
  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });
}

const responseText =
  "Hello! 👋 I'm the legacy PolicyWonk Bot. Please visit https://policywonk.ucdavis.edu to ask your question.";

// mentions
app.event("app_mention", async ({ event, client }) => {
  try {
    // Reply in a thread
    await client.chat.postMessage({
      channel: event.channel,
      text: responseText,
      thread_ts: event.ts, // This is crucial, as it starts the thread by using the timestamp of the event message
    });
  } catch (error) {
    console.error(error);
  }
});

// slash commands
const handleSlashCommand = async ({
  ack,
  respond,
}: {
  ack: AckFn<string | RespondArguments>;
  payload: SlashCommand;
  respond: RespondFn;
}) => {
  try {
    await ack();

    await respond(responseText);
  } catch (error) {
    console.error(error);
  }
};

app.command("/policy3", async ({ ack, payload, respond }) => {
  await handleSlashCommand({ ack, payload, respond });
});

app.command("/policy", async ({ ack, payload, respond }) => {
  await handleSlashCommand({ ack, payload, respond });
});

(async () => {
  // Start your app
  const port = process.env.PORT || 3000;
  await app.start(port);

  await ensureLogIndexExists();

  console.log(`⚡️ PolicyWonk is running at ${port}`);
})();
