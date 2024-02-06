import { Client, ClientOptions } from '@elastic/elasticsearch';
import {
  ElasticClientArgs,
  ElasticVectorSearch,
} from 'langchain/vectorstores/elasticsearch';
import { OpenAIEmbeddings } from 'langchain/embeddings/openai';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { Document } from 'langchain/document';
import ExcelJS from 'exceljs';
import { compile } from 'html-to-text';

const compiledConvert = compile(); // options could be passed here

// let's try to do full RAG with OpenAI assistants & ElasticSearch
const apiKey = process.env.OPENAI_API_KEY; // Replace with your API key or use environment variable
if (!apiKey) {
  console.error('OpenAI API key is required');
  process.exit(1);
}

// embeddings
const embeddings = new OpenAIEmbeddings();

// get my vector store
// const config: ClientOptions = {
//   node: process.env.ELASTIC_URL ?? 'http://127.0.0.1:9200',
// };

const config: ClientOptions = {
  node: process.env.ELASTIC_URL ?? 'http://127.0.0.1:9200',
  auth: {
    username: process.env.ELASTIC_WRITE_USERNAME ?? 'elastic',
    password: process.env.ELASTIC_WRITE_PASSWORD ?? 'changeme',
  },
};

const clientArgs: ElasticClientArgs = {
  client: new Client(config),
  indexName: process.env.ELASTIC_INDEX ?? 'kb_vectorstore',
  vectorSearchOptions: {
    similarity: 'cosine', // since this is what openAI uses
  },
};

// const vectorStore = new ElasticVectorSearch(embeddings, clientArgs);
const processIntoDocuments = async (documents: KbDocument[]) => {
  const processedDocuments = documents.map((document) => {
    const text = compiledConvert(document.htmlContent);

    // append the title to the top of the text since it might be helpful in searching
    const textWithTitle = `${document.title} ${text}`;

    return new Document({
      pageContent: textWithTitle,
      metadata: { id: document.id, title: document.title },
    });
  });

  //   console.log('textOnly', textOnly, metadata);

  // split the documents into chunks
  // TODO: play with chunk size & overlap
  // TODO: this doesn't work too well with content in tables
  const textSplitter = new RecursiveCharacterTextSplitter();

  const splitDocs = await textSplitter.splitDocuments(processedDocuments);

  console.log('storing in elastic split docs: ', splitDocs.length);

  // batch the splitDocs into 200 at a time
  const batchedSplitDocs = [];

  for (let i = 0; i < splitDocs.length; i += 200) {
    batchedSplitDocs.push(splitDocs.slice(i, i + 200));
  }

  // store the docs in batches
  for (const batch of batchedSplitDocs) {
    console.log('storing batch size: ', batch.length);
    await ElasticVectorSearch.fromDocuments(batch, embeddings, clientArgs);
  }

  console.log('storage complete');
};

// get back the rows from the excel file
const processExcel = async (path: string) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet(1);

  if (!sheet) {
    throw new Error('Sheet not found');
  }

  const documents: KbDocument[] = [];

  sheet.eachRow(async (row) => {
    const id = row.getCell('A').value?.toString() ?? '';
    const title = row.getCell('E').value?.toString() ?? '';
    const htmlContent = row.getCell('J').value?.toString() ?? '';

    documents.push({
      id,
      title,
      htmlContent,
      text: '',
    });
  });

  return documents;
};

const main = async () => {
  const docs = await processExcel(
    '/Users/postit/Documents/projects/kb-bot/docs/kb_knowledge.xlsx',
  );

  console.log('doc count: ', docs.length);

  await processIntoDocuments(docs);
};

main()
  .then(() => {
    console.log('Done');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

interface KbDocument {
  id: string;
  title: string;
  htmlContent: string;
  text: string;
}
