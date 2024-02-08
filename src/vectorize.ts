import { Client, ClientOptions } from "@elastic/elasticsearch";
import {
  ElasticClientArgs,
  ElasticVectorSearch,
} from "@langchain/community/vectorstores/elasticsearch";
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { Document } from "langchain/document";
import dotenv from "dotenv";
import path from "path";
import * as fs from "fs";

dotenv.config(); // load up .env file

// let's try to do full RAG with OpenAI assistants & ElasticSearch
const apiKey = process.env.OPENAI_API_KEY; // Replace with your API key or use environment variable
if (!apiKey) {
  console.error("OpenAI API key is required");
  process.exit(1);
}

// embeddings
const embeddings = new OpenAIEmbeddings();

const config: ClientOptions = {
  node: process.env.ELASTIC_URL ?? "http://127.0.0.1:9200",
  auth: {
    username: process.env.ELASTIC_WRITE_USERNAME ?? "",
    password: process.env.ELASTIC_WRITE_PASSWORD ?? "",
  },
};

const clientArgs: ElasticClientArgs = {
  client: new Client(config),
  indexName: process.env.ELASTIC_INDEX ?? "vectorstore",
  vectorSearchOptions: {
    similarity: "cosine", // since this is what openAI uses
  },
};

// revisions are classified as "Resource" but we don't want to include them in the search
const ignoredClassifications = ["Resource"];

const deleteIndexIfExists = async () => {
  // remove the elastic search index if it exists
  await clientArgs.client.indices.delete({
    index: clientArgs.indexName ?? "",
    ignore_unavailable: true,
  });
};

const processIntoDocuments = async (
  scope: string,
  section: string,
  documents: PolicyDocument[]
) => {
  const processedDocuments = documents.map((document) => {
    const text = document.content ?? "";

    // TODO: I think the title is always in the text but let's check

    return new Document({
      pageContent: text,
      metadata: {
        scope: scope,
        section: section,
        title: document.title,
        url: document.url,
        responsible_office: document.responsible_office,
        subject_areas: document.subject_areas,
        effective_date: document.effective_date,
        issuance_date: document.issuance_date,
        keywords: document.keywords,
        classifications: document.classifications,
      },
    });
  });

  // split the documents into chunks
  // TODO: play with chunk size & overlap
  const textSplitter = new RecursiveCharacterTextSplitter();

  const splitDocs = await textSplitter.splitDocuments(processedDocuments);

  console.log("storing in elastic split docs: ", splitDocs.length);

  // batch the splitDocs into 200 at a time
  const batchedSplitDocs = [];

  for (let i = 0; i < splitDocs.length; i += 200) {
    batchedSplitDocs.push(splitDocs.slice(i, i + 200));
  }

  // store the docs in batches
  for (const batch of batchedSplitDocs) {
    console.log("storing batch size: ", batch.length);
    await ElasticVectorSearch.fromDocuments(batch, embeddings, clientArgs);
  }

  console.log("storage complete");
};

const loadPolicyData = async (directory: string) => {
  // data is a list of TXT files and a special JSON file that contains metadata

  // load the metadata
  const metadataPath = path.join(directory, "metadata.json");

  let metadata: PolicyDocument[];

  try {
    metadata = JSON.parse(
      await fs.promises.readFile(metadataPath, "utf-8")
    ) as PolicyDocument[];
  } catch (error) {
    console.error("Error reading metadata file:", error);
    process.exit(1);
  }

  // filter out the ignored classifications
  metadata = metadata.filter(
    (doc) =>
      !doc.classifications ||
      !doc.classifications.some((classification) =>
        ignoredClassifications.includes(classification)
      )
  );

  // go through each .txt file and load the content
  for (const docMetadata of metadata) {
    const docPath = path.join(directory, `${docMetadata.filename}.txt`);

    try {
      const content = await fs.promises.readFile(docPath, "utf-8");
      docMetadata.content = content;
    } catch (error) {
      console.error("Error reading file:", error);
    }
  }

  return metadata;
};

const main = async () => {
  console.log("Starting");

  // TODO: would be nice to only update the index if the data has changed
  // clear the ES index
  await deleteIndexIfExists();

  // get all folders in our policy directory
  const policyDirectory = "/workspaces/policy";

  const policyDirectoryEntities = await fs.promises.readdir(policyDirectory, {
    withFileTypes: true,
  });

  // get all non-hidden directories
  const policyDirectories = policyDirectoryEntities.filter(
    (dirent) => dirent.isDirectory() && !dirent.name.startsWith(".")
  );

  for (const directory of policyDirectories) {
    console.log("Processing directory: ", directory.name, directory.path);

    const docs = await loadPolicyData(
      path.join(directory.path, directory.name)
    );

    console.log(`${directory.name} doc count: `, docs.length);

    const scope = directory.name === "ucop" ? "ucop" : "ucd";

    await processIntoDocuments(scope, directory.name, docs);
  }
};

main()
  .then(() => {
    console.log("Done");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

type Metadata = {
  title: string;
  filename: string;
  effective_date: string;
  issuance_date: string;
  url: string;
  manual: string; // the manual this policy is in
  responsible_office: string;
  subject_areas: string[];
  classifications: string[];
  keywords: string[];
};

type PolicyDocument = Metadata & {
  content?: string;
};
