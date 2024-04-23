import { Client, ClientOptions } from "@elastic/elasticsearch";
import dotenv from "dotenv";
import { AnswerQuestionFunctionArgs, MessageMetadata } from "./app_llm";

dotenv.config();

// get my elastic DB in write mode
const config: ClientOptions = {
  node: process.env.ELASTIC_URL ?? "http://127.0.0.1:9200",
  auth: {
    username: process.env.ELASTIC_WRITE_USERNAME ?? "elastic",
    password: process.env.ELASTIC_WRITE_PASSWORD ?? "changeme",
  },
};

const searchClient: Client = new Client(config);

const indexName = process.env.ELASTIC_LOG_INDEX ?? "test_vectorstore_logs";

export const ensureLogIndexExists = async () => {
  const indexExists = await searchClient.indices.exists({ index: indexName });

  if (indexExists) {
    console.log(`Index ${indexName} already exists.`);
    return;
  }

  // ensure the index exists
  await searchClient.indices.create({
    index: indexName,
    body: {
      mappings: {
        properties: {
          user_id: { type: "keyword" },
          channel_id: { type: "keyword" },
          team_id: { type: "keyword" },
          interaction_type: { type: "keyword" },
          llm_model: { type: "keyword" },
          query: { type: "text" },
          response: { type: "object" },
          reaction: { type: "keyword" },
          timestamp: { type: "date" },
        },
      },
    },
  });

  console.log(`Index ${indexName} created.`);
};

// use elasticsearch to log the user's query and the results
export const logResponse = async (
  id: string,
  metadata: MessageMetadata,
  query: string,
  response: AnswerQuestionFunctionArgs[]
) => {
  // log the query and the results to elasticsearch
  await searchClient.index({
    index: indexName,
    id,
    body: {
      ...metadata,
      query,
      response,
    },
  });
};

/**
 * Logs a reaction for a given ID.
 * @param id - The ID of the item to log the reaction for.
 * @param reaction - The reaction to log.
 */
export const logReaction = async (id: string, reaction: string) => {
  await searchClient.update({
    index: indexName,
    id,
    body: {
      doc: {
        reaction,
      },
    },
  });
};
