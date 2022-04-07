import { BigQuery, BigQueryOptions, Query } from "@google-cloud/bigquery";
import { Field, Results } from "./types";

export type JobInfo = {
  kind: string;
  etag: string;
  id: string;
  selfLink: string;
  // user_email: string;
  configuration: {
    query: {
      query: string;
      destinationTable: TableReference;
      writeDisposition: string;
      priority: string;
      useLegacySql: boolean;
    };
    jobType: string;
  };
  jobReference: {
    projectId: string;
    jobId: string;
    location: string;
  };
  statistics: {
    creationTime: string;
    startTime: string;
    endTime: string;
    totalBytesProcessed: string;
    query: {
      totalBytesProcessed: string;
      totalBytesBilled: string;
      cacheHit: boolean;
      statementType: string;
    };
  };
  status: {
    state: string;
  };
};

export type Table = {
  kind: string;
  etag: string;
  id: string;
  selfLink: string;
  tableReference: TableReference;
  schema: Schema;
  numBytes: string;
  numLongTermBytes: string;
  numRows: string;
  creationTime: string;
  expirationTime: string;
  lastModifiedTime: string;
  type: "TABLE";
  location: string;
};

export type Schema = {
  fields?: Array<Field>;
};

export type TableReference = {
  projectId: string;
  datasetId: string;
  tableId: string;
};

export type Client = ReturnType<typeof createClient> extends Promise<infer T>
  ? T
  : never;
export type RunJob = ReturnType<Client["createRunJob"]> extends Promise<infer T>
  ? T
  : never;
export type DryRunJob = ReturnType<Client["createDryRunJob"]> extends Promise<
  infer T
>
  ? T
  : never;

export class AuthenticationError extends Error {
  constructor(keyFilename?: string) {
    super(
      keyFilename
        ? `Bad authentication: Make sure that "${keyFilename}", which is set in bigqueryRunner.keyFilename of setting.json, is the valid path to service account key file`
        : `Bad authentication: Set bigqueryRunner.keyFilename of your setting.json to the valid path to service account key file`
    );
  }
}

export class NoPageTokenError extends Error {
  constructor(page: number) {
    super(`no page token for page at ${page}`);
  }
}

export type RunInfo = {
  readonly query: {
    readonly totalBytesProcessed: string;
    readonly totalBytesBilled: string;
    readonly cacheHit: boolean;
    readonly statementType: string;
  };
  readonly schema: {
    readonly fields: Array<Field>;
  };
  readonly numRows: string;
};

export async function createClient(options: BigQueryOptions) {
  const bigQuery = new BigQuery({
    scopes: [
      // Query Drive data: https://cloud.google.com/bigquery/external-data-drive
      "https://www.googleapis.com/auth/drive",
    ],
    ...options,
  });
  try {
    await bigQuery.authClient.getProjectId();
  } catch (err) {
    if (
      (err as { message: string }).message &&
      (err as { message: string }).message.startsWith(
        "Unable to detect a Project Id in the current environment."
      )
    ) {
      throw new AuthenticationError(options.keyFilename);
    }
  }

  return {
    async createRunJob(query: Omit<Query, "dryRun">): Promise<{
      id: string;
      destinationTable: string | undefined;
      getRows(): Promise<Results>;
      getPrevRows(): Promise<Results>;
      getNextRows(): Promise<Results>;
      getInfo(): Promise<RunInfo>;
    }> {
      const [job, info] = await bigQuery.createQueryJob({
        ...query,
        dryRun: false,
      });

      if (
        ["CREATE_TABLE_AS_SELECT", "MERGE"].some(
          (type) => info.statistics?.query?.statementType === type
        ) &&
        info.configuration?.query?.destinationTable
      ) {
        // Wait for completion of table creation job
        // to get the records of the table just created.
        for (let i = 0; i < 10; i++) {
          const metadata = await job.getMetadata();
          const info: JobInfo | undefined = metadata.find(
            ({ kind }) => kind === "bigquery#job"
          );
          if (!info) {
            continue;
          }
          if (info.status.state === "DONE") {
            break;
          }
          if (i === 9) {
            throw new Error(
              `waiting for completion of table creation job timed out`
            );
          }
          await sleep(1000);
        }

        return this.createRunJob({
          ...query,
          query: `select * from \`${datasourceName(
            info.configuration.query.destinationTable
          )}\``,
        });
      }

      if (!job.id) {
        throw new Error(`no job ID`);
      }

      const tokens: Map<number, string | null> = new Map([[0, null]]);
      let current = 0;

      return {
        id: job.id,

        destinationTable: datasourceName(
          info.configuration?.query?.destinationTable
        ),

        async getRows(): Promise<Results> {
          const [structs, next] = await job.getQueryResults({
            maxResults: query.maxResults,
          });
          if (next?.pageToken) {
            tokens.set(current + 1, next.pageToken);
          }
          return {
            structs,
            page: {
              maxResults: query.maxResults,
              current,
            },
          };
        },

        async getPrevRows(): Promise<Results> {
          const pageToken = tokens.get(current - 1);
          if (pageToken === undefined) {
            throw new NoPageTokenError(current - 1);
          }
          current -= 1;
          const [rows, next] = await job.getQueryResults({
            maxResults: query.maxResults,
            pageToken: pageToken ?? undefined,
          });
          if (next?.pageToken) {
            tokens.set(current + 1, next.pageToken);
          }
          return {
            structs: rows,
            page: {
              maxResults: query.maxResults,
              current,
            },
          };
        },

        async getNextRows(): Promise<Results> {
          const pageToken = tokens.get(current + 1);
          if (pageToken === undefined) {
            throw new NoPageTokenError(current + 1);
          }
          current += 1;
          const [rows, next] = await job.getQueryResults({
            maxResults: query.maxResults,
            pageToken: pageToken ?? undefined,
          });
          if (next?.pageToken) {
            tokens.set(current + 1, next.pageToken);
          }
          return {
            structs: rows,
            page: {
              maxResults: query.maxResults,
              current,
            },
          };
        },

        async getInfo() {
          let jobInfo: JobInfo;
          for (;;) {
            const metadata = await job.getMetadata();
            const info: JobInfo | undefined = metadata.find(
              ({ kind }) => kind === "bigquery#job"
            );
            if (!info) {
              // throw new Error(`no job info: ${job.id}`);
              continue;
            }
            if (info.status.state === "DONE") {
              jobInfo = info;
              break;
            }
            await sleep(1000);
          }
          const {
            configuration: {
              query: {
                destinationTable: { projectId, datasetId, tableId },
              },
            },
            statistics: { query },
          } = jobInfo;

          const res = await bigQuery.dataset(datasetId).table(tableId).get();
          const table: Table = res.find(
            ({ kind }) => kind === "bigquery#table"
          );
          if (!table) {
            throw new Error(
              `no table info: ${projectId}.${datasetId}.${tableId}`
            );
          }
          const {
            schema: { fields },
            numRows,
          } = table;
          if (!fields) {
            throw new Error(`schema has no fields`);
          }
          return {
            query,
            schema: { fields },
            numRows,
          };
        },
      };
    },

    async createDryRunJob(query: Omit<Query, "dryRun">) {
      const data = await bigQuery.createQueryJob({ ...query, dryRun: true });
      const job = data[0];
      if (!job.id) {
        throw new Error(`no job ID`);
      }
      return {
        id: job.id,
        getInfo(): { totalBytesProcessed: number } {
          const { totalBytesProcessed } = job.metadata.statistics;
          return {
            totalBytesProcessed:
              typeof totalBytesProcessed === "number"
                ? totalBytesProcessed
                : typeof totalBytesProcessed === "string"
                ? parseInt(totalBytesProcessed, 10)
                : 0,
          };
        },
      };
    },
  };
}

function datasourceName(table?: {
  projectId?: string;
  datasetId?: string;
  tableId?: string;
}): string | undefined {
  if (!table) {
    return;
  }
  const { projectId, datasetId, tableId } = table;
  return [projectId, datasetId, tableId].filter((v) => !!v).join(".");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
