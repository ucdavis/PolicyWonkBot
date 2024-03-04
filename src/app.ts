/**
 * This file contains the implementation of a Slack app called "Policy Wonk".
 * It uses the @slack/bolt library to handle events and slash commands.
 * The app interacts with the OpenAI API to generate responses to user queries.
 * It also utilizes the @elastic/elasticsearch library to perform vector searches on an Elasticsearch index.
 * The app listens for app mentions and slash commands, and responds with answers and citations.
 * The main functionality is implemented in the event and command handlers.
 */
import { Client, ClientOptions } from "@elastic/elasticsearch";
import {
  App,
  AckFn,
  RespondArguments,
  SlashCommand,
  RespondFn,
} from "@slack/bolt";
import dotenv from "dotenv";
import OpenAI from "openai";
import { ChatCompletionTool } from "openai/resources/chat/completions";

dotenv.config();

const openai = new OpenAI();

// define our models to use
const model4 = "gpt-4-0125-preview"; // GPT-4 Turbo
const model3 = "gpt-3.5-turbo-0125"; // GPT-3.5 Turbo

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

// let's try to do full RAG with OpenAI assistants & ElasticSearch
const openAIApiKey = process.env.OPENAI_API_KEY; // Replace with your API key or use environment variable
if (!openAIApiKey) {
  console.error("OpenAI API key is required");
  process.exit(1);
}
// get my vector store
const config: ClientOptions = {
  node: process.env.ELASTIC_URL ?? "http://127.0.0.1:9200",
  auth: {
    username: process.env.ELASTIC_SEARCHER_USERNAME ?? "elastic",
    password: process.env.ELASTIC_SEARCHER_PASSWORD ?? "changeme",
  },
};

const searchClient: Client = new Client(config);

const indexName = process.env.ELASTIC_INDEX ?? "test_vectorstore4";

// mentions
app.event("app_mention", async ({ event, client }) => {
  const modelName = model4; // use gpt4 for testing -- slow but better answers

  try {
    // First, react to the mention with an emoji
    await client.reactions.add({
      channel: event.channel,
      name: "eyes", // Emoji code, replace 'eyes' with the emoji you want to use without colons
      timestamp: event.ts,
    });

    // get the payload text
    const payloadText = event.text;

    const responseText = generateInitialResponseText(modelName, payloadText);

    // Reply in a thread
    await client.chat.postMessage({
      channel: event.channel,
      text: responseText,
      thread_ts: event.ts, // This is crucial, as it starts the thread by using the timestamp of the event message
    });

    // get ask our AI
    const response = await getResponse(payloadText, modelName);

    // convert to slack blocks
    const blocks = convertToBlocks(response);

    // Post another message in the thread after the API call
    await client.chat.postMessage({
      channel: event.channel,
      blocks: blocks,
      text: convertToText(response),
      thread_ts: event.ts,
    });
  } catch (error) {
    console.error(error);
  }
});

// slash commands
const handleSlashCommand = async ({
  ack,
  payload,
  respond,
  modelName,
}: {
  ack: AckFn<string | RespondArguments>;
  payload: SlashCommand;
  respond: RespondFn;
  modelName: string;
}) => {
  try {
    await ack();

    const payloadText = payload.text;

    if (!payloadText) {
      await respond(
        "You can ask me anything about the knowledge base. ex: /kb how to create a new user?"
      );
      return;
    }

    // send a message using chat.postMessage
    await respond(generateInitialResponseText(modelName, payloadText));

    // get ask our AI
    const response = await getResponse(payloadText, modelName);

    // get back our structured response
    // console.log('response', response);

    // convert to slack blocks
    const blocks = convertToBlocks(response);

    // update the message with the response
    await respond({
      blocks: blocks,
    });
  } catch (error) {
    console.error(error);
  }
};

app.command("/policy3", async ({ ack, payload, respond }) => {
  await handleSlashCommand({ ack, payload, respond, modelName: model3 });
});

app.command("/policy", async ({ ack, payload, respond }) => {
  await handleSlashCommand({ ack, payload, respond, modelName: model4 });
});

// just in case we can't render with blocks
const convertToText = (content: AnswerQuestionFunctionArgs[]) => {
  let message = "";
  for (const answer of content) {
    message += answer.content + "\n\n";
    if (answer.citations.length > 0) {
      message += "*Citations*\n";
      answer.citations.forEach((citation) => {
        message += `<${citation.url}|${citation.title}>\n`;
      });
    }
  }
  return message;
};

const convertToBlocks = (content: AnswerQuestionFunctionArgs[]) => {
  // Constructing Slack message blocks
  const messageBlocks = [];

  for (const answer of content) {
    const cleanedAnswerContent = cleanupContent(answer.content);
    messageBlocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: cleanedAnswerContent,
      },
    });

    if (answer.citations.length > 0) {
      messageBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Citations*",
        },
      });

      answer.citations.forEach((citation) => {
        messageBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<${citation.url}|${citation.title}>`,
          },
        });
      });
    }
  }

  return messageBlocks;
};

const generateInitialResponseText = (
  modelName: string,
  payloadText: string
) => {
  return `Policy Wonk v0.1-beta by Scott Kirkland. model ${modelName}, elastic dense vector + cosine, recursive character vectorization. \n\n You asked me: '${payloadText}'. Getting an answer to your question...`;
};

const cleanupTitle = (title: string) => {
  // replace any quotes
  return title.replace(/"/g, "");
};

const cleanupContent = (content: string) => {
  // if we find any markdown links [title](url), replace them with the special slack format <url|title>
  return content.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>");
};

const getEmbeddings = async (query: string) => {
  // get our embeddings
  const embeddings = await openai.embeddings.create({
    model: "text-embedding-3-large", // needs to be the same model as we used to index
    input: query,
  });

  return embeddings;
};

const getResponse = async (query: string, modelName: string) => {
  // assume the index is already created
  const queryEmbeddings = await getEmbeddings(query);

  const searchResultMaxSize = 5;
  // get our search results
  const searchResults = await searchClient.search({
    index: indexName,
    size: searchResultMaxSize,
    body: {
      knn: {
        field: "vector", // the field we want to search, created by PolicyAcquisition
        query_vector: queryEmbeddings.data[0].embedding, // the query vector
        k: searchResultMaxSize,
        num_candidates: 200,
      },
    },
  });

  // Each document should be delimited by triple quotes and then note the excerpt of the document
  const docText = searchResults.hits.hits.map((hit: any) => {
    return `"""${hit._source.text}\n\n-from <${hit._source.metadata.url},
    )}|${cleanupTitle(hit._source.metadata.title)}>"""`;
  });

  // console.log('docText', docText);

  // construct our tool function which defines the expected output structure
  const tools: ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "answer_question",
        description: "Answer a question and provide citations",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "The content of the answer to the question, in markdown format",
            },
            citations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: {
                    type: "string",
                    description: "The title of the document cited",
                  },
                  url: {
                    type: "string",
                    format: "uri",
                    description: "The url of the document cited",
                  },
                },
                required: ["title", "url"],
                additionalProperties: false,
              },
            },
          },
          required: ["content", "citations"],
          additionalProperties: false,
        },
      },
    },
  ];

  const response = await openai.chat.completions.create({
    model: modelName,
    messages: [
      {
        role: "system",
        content: `
        You are a helpful assistant who is an expert in university policy at UC Davis. You will be provided with several documents each delimited by triple quotes and then asked a question.
      Your task is to answer the question in nicely formatted markdown using only the provided documents and to cite the the documents used to answer the question. 
      If the documents do not contain the information needed to answer this question then simply write: "Insufficient information to answer this question." 
      If an answer to the question is provided, it must be annotated with a citation. Only call 'answer_question' once after your entire answer has been formulated. \n\n ${docText}`,
      },
      {
        role: "user",
        content: "Question: " + query,
      },
    ],
    temperature: 0.2, // play with this to get more consistent results
    tools: tools,
    tool_choice: { type: "function", function: { name: "answer_question" } },
  });

  // get the most recent message
  const responseMessage = response.choices[0].message;

  // console.log('responseMessage', responseMessage);

  // Step 2: check if the model wanted to call a function
  const toolCalls = responseMessage.tool_calls;

  if (toolCalls) {
    // we have a tool call. should only be one but let's loop anyway and build up our response
    // console.log('toolCalls', toolCalls);
    return toolCalls.map((toolCall) => {
      return JSON.parse(
        toolCall.function.arguments
      ) as AnswerQuestionFunctionArgs;
    });
  } else {
    // our function wasn't called -- don't think that should happen?
    return [
      {
        content:
          "sorry, something went wrong trying to answer your question.  Please try again.",
        citations: [],
      },
    ];
  }
};

(async () => {
  // Start your app
  const port = process.env.PORT || 3000;
  await app.start(port);

  console.log(`⚡️ Bolt app is running at ${port}`);
})();

interface AnswerQuestionFunctionArgs {
  content: string;
  citations: {
    title: string;
    url: string;
  }[];
}
