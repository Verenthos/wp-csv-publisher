#!/usr/bin/env node
/**
 * Entry point.
 *
 *   node --env-file=.env publish-articles.js articles.csv [--report report.csv]
 *
 * Reads the CSV, validates every row, schedules the valid rows on WordPress through the
 * REST API, and writes a per-row report. Exit codes:
 *   0  every row was posted
 *   2  the run completed but some rows failed validation or the API call
 *   1  fatal: bad configuration, unreadable CSV, or the report could not be written
 */

import { parseArgs } from 'node:util';
import { loadConfig } from './src/config.js';
import { readArticlesCsv } from './src/csv-reader.js';
import { WordPressClient } from './src/wp-client.js';
import { runPublish } from './src/run.js';
import { writeReport, summarize } from './src/report.js';
import { FatalError } from './src/errors.js';

const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_ROW_FAILURES = 2;

async function main() {
  const { csvPath, reportPath } = parseCommandLine();
  const config = loadConfig(process.env);

  const articles = readArticlesCsv(csvPath);
  console.log(`Read ${articles.length} row(s) from ${csvPath}`);

  const client = new WordPressClient(config);
  const results = await runPublish({ articles, client, now: new Date(), logger: console });

  writeReport(reportPath, results);

  const summary = summarize(results);
  console.log(
    `\nDone. ${summary.total} row(s): ${summary.posted} posted, ` +
      `${summary.validation_failed} validation_failed, ${summary.api_failed} api_failed. ` +
      `Report: ${reportPath}`,
  );

  return summary.posted === summary.total ? EXIT_OK : EXIT_ROW_FAILURES;
}

function parseCommandLine() {
  const { values, positionals } = parseArgs({
    options: { report: { type: 'string', default: 'report.csv' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new FatalError('Usage: node --env-file=.env publish-articles.js <articles.csv> [--report <report.csv>]');
  }
  return { csvPath: positionals[0], reportPath: values.report };
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof FatalError) {
      console.error(`Fatal: ${error.message}`);
    } else {
      console.error('Fatal: unexpected error');
      console.error(error);
    }
    process.exit(EXIT_FATAL);
  });
