import * as path from "path";
import chalk from "chalk";
import klaw from "klaw";
import { filterFiles } from "./lib/pipes/filterFiles";
import { PostcssPipeResult } from "./lib/pipes/processPostcss";
import { getErrorCollector } from "./lib/util/error-collector";
import { compileFile, compilerPipe } from "./lib/compilerPipe";
import { Options as SassOptions } from "sass";
import { writeFile } from "./lib/util/fs-util";

type OutputStyle = "compressed" | "expanded";

/**
 * The paramets to pass in from the command
 */
export interface Params {
  context: string;
  dir: string[];
  outputStyle: OutputStyle;
  sourceMap: boolean;
  watch: boolean;
  debug: boolean;
}

/**
 * The configuration for a single entry
 */
export interface EntryConfig {
  srcRelative: string;
  outRelative: string;
  src: string;
  out: string;
  postsassConfig: {
    postcss: any;
    sass: SassOptions;
  };
}

// A map of which file is a dependency of another file
const relationships: { [key: string]: string[] } = {};

const debugDir = path.resolve(process.cwd(), "_postsassDebug");

/**
 * Compile scss files
 * @param params
 */
export async function compile(params: Params) {
  const { context, outputStyle, sourceMap, dir, watch } = params;
  console.info(chalk.blue.bold("Using output style"), chalk.green(outputStyle));
  console.info(chalk.blue.bold("Source Map"), chalk.green(sourceMap));

  let postsassConfig = await loadConfig(params);
  // create a configuration for each entry directory
  const entries: EntryConfig[] = dir.map((d) => {
    // split at semicolon
    const split = d.split(":", 2);

    const src = split[0];
    // no output path specified = use src dir for output
    const out = split[1] ?? split[0];
    // create a configuration for the entry dir
    const conf: EntryConfig = {
      srcRelative: src,
      outRelative: out,
      src: path.resolve(context, src),
      out: path.resolve(context, out),
      postsassConfig,
    };
    return conf;
  });
  // create promises for each entry
  const cbs = entries.map(
    async (entry) =>
      new Promise((resolve, reject) => {
        const { srcRelative, outRelative, src } = entry;
        console.info(
          chalk.blue.bold("Source dir"),
          chalk.magenta(srcRelative),
          chalk.yellow(" => "),
          chalk.blue.bold("Output dir"),
          chalk.magenta(outRelative)
        );

        // Use klaw to recursively walk the directories
        klaw(src + "/")
          .pipe(filterFiles()) // ony use scss files
          .pipe(compilerPipe(entry)) // make a few transformations with postcss
          .on("data", dataListener(params, entry)) // need to process data to trigger the "end" event to resolve the promise
          .on("end", resolve); // resolve promise
      })
  );

  try {
    // Wait until all files are processed
    await Promise.all(cbs);
  } catch (e) {
    console.error(chalk.red(chalk.bold("Error occured:"), e.message));
    console.error(e.stack);
    process.exitCode = 1;
    return;
  }
  // Check if any errors occured while compiling the sass files
  const errors = getErrorCollector();
  if (errors.hasErrors()) {
    console.error(chalk.bold.red("Erorrs occured while compiling:"));
    errors.forEach((e) => console.error(e.message));
    process.exitCode = 2;
    return;
  }

  // Write debug info if enabled
  if (params.debug) {
    await writeFile(path.resolve(debugDir, "relationships.json"), JSON.stringify(relationships, null, 2));
  }

  console.info(chalk.bold.green("All files compiled successfully!"));
  // Are we done yet?
  if (watch) {
    await enableWatchMode(params, entries);
    console.info("Graceful Shutdown");
    process.exitCode = 0;
    return;
  }
}

/**
 * Show a bit of info what should
 */
function dataListener(params: Params, entry: EntryConfig) {
  return async (d: PostcssPipeResult) => {
    console.info(
      chalk.bold(
        chalk.blue(d.from.replace(entry.src, entry.srcRelative)),
        chalk.yellow("=>"),
        chalk.blue(d.to.replace(entry.out, entry.outRelative))
      )
    );
    // write debug info: which parts are a part of the file
    // FIXME: Use a better ouput filename to avoid collisions
    if (params.debug) {
      await writeFile(
        path.resolve(debugDir, "relations", path.basename(d.from) + ".json"),
        JSON.stringify(d.sassResult.stats.includedFiles, null, 2)
      );
    }
    if (params.watch || params.debug) {
      relationTracker(d);
    }
  };
}

// track the dependency relations between files
// when a file is changed, all its dependants should be updated
// includedFiles includes the entry file as well
function relationTracker(d: PostcssPipeResult) {
  d.sassResult.stats.includedFiles.forEach((f) => {
    if (!(f in relationships)) {
      relationships[f] = [];
      relationships[f].push(d.from);
    } else if (relationships[f].indexOf(d.from) === -1) {
      relationships[f].push(d.from);
    }
  });
}

async function enableWatchMode(params: Params, entries: EntryConfig[]) {
  try {
    // Chokidar is a nice tool for watching directories for changes.
    const chokidar = await import("chokidar");
    console.info(chalk.bold.cyan("Starting Watch Mode"));

    // Start watcher for every source set
    const promises = entries.map((entry) => {
      return new Promise<void>((resolve, reject) => {
        // create a pattern to watch all scss files
        const watchPattern = path.resolve(params.context, entry.srcRelative, "**/*.scss");
        const watcher = chokidar.watch(watchPattern);
        watcher
          // Show a little info when the watcher is ready to roll
          .on("ready", () =>
            console.info(chalk.bold(chalk.blue("Watching changes for"), chalk.magenta(entry.srcRelative)))
          )
          // Show a little info when a file has been removed
          .on("unlink", (path) => console.info(chalk.red(`File ${path} has been removed`)))
          // register the change handler
          .on("change", changeHandler(entry));
        process.on("SIGINT", () => {
          watcher.close().then(() => resolve());
        });
      });
    });
    return Promise.all(promises);
  } catch (e) {
    console.error(e);
    return;
  }
}

// The change listener for watchmode
function changeHandler(entry: EntryConfig) {
  return async (path: string) => {
    console.info(chalk.bold(chalk.blue("File changed:", chalk.magenta(path))));
    // Recompile all files that depend on the changed file
    if (path in relationships) {
      for (const p of Object.values(relationships[path])) {
        try {
          const write = await compileFile(p, entry);
          console.info(
            chalk.bold(chalk.blue("Updated file", chalk.magenta(write.from.replace(entry.src, entry.srcRelative))))
          );
        } catch (e) {
          console.error(chalk.bold.red("Error when compiling", p), e.message);
        }
      }
    }
  };
}

async function loadConfig(params: Params): Promise<EntryConfig["postsassConfig"]> {
  const sassCliConfig = { outputStyle: params.outputStyle, sourceMap: params.sourceMap };
  let fileConfig;
  const builder = {
    postcss: null,
    sass: sassCliConfig,
  };
  try {
    fileConfig = await import(path.resolve(process.cwd(), "postsass.config.js"));
    if (typeof fileConfig.postcss === "object") {
      builder.postcss = fileConfig.postcss;
    }
    if (typeof fileConfig.sass === "object") {
      builder.sass = { ...fileConfig.sass, ...sassCliConfig };
    }
  } catch (e) {
    console.warn("No postsass config file found");
    if (!e.code) {
      console.error(e);
    }
  }
  return builder;
}
