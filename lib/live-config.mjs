import path from "node:path";
import { loadEnvValue } from "./util.mjs";

export function resolveOpenAIKeyConfig({
  environment = process.env,
  envFile = null,
  workspaceRoot,
}) {
  if (envFile) {
    let apiKey;
    try {
      apiKey = loadEnvValue(path.resolve(workspaceRoot, envFile));
    } catch {
      throw Object.assign(
        new Error("The explicit --key-env-file could not be read."),
        { code: "OPENAI_API_KEY_FILE_UNREADABLE" },
      );
    }
    if (!apiKey) {
      throw Object.assign(
        new Error(
          "The explicit --key-env-file does not contain a non-empty OPENAI_API_KEY.",
        ),
        { code: "OPENAI_API_KEY_FILE_INVALID" },
      );
    }
    return {
      apiKey,
      source: "key-env-file",
    };
  }

  const apiKey =
    typeof environment.OPENAI_API_KEY === "string"
      ? environment.OPENAI_API_KEY.trim()
      : null;
  if (!apiKey) {
    throw Object.assign(
      new Error(
        "Live mode requires OPENAI_API_KEY or --key-env-file pointing to a confirmed local env file.",
      ),
      { code: "OPENAI_API_KEY_MISSING" },
    );
  }
  return {
    apiKey,
    source: "environment",
  };
}

export function resolveOpenAIApiKey(options) {
  return resolveOpenAIKeyConfig(options).apiKey;
}
