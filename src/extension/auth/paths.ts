import * as os from "os";
import * as path from "path";

export const DAMOCLES_CONFIG_DIR: string = path.join(os.homedir(), ".damocles", "auth");
export const DAMOCLES_CREDENTIALS_FILENAME: string = ".credentials.json";
export const DAMOCLES_CREDENTIALS_PATH: string = path.join(DAMOCLES_CONFIG_DIR, DAMOCLES_CREDENTIALS_FILENAME);
export const CLI_CONFIG_DIR: string = path.join(os.homedir(), ".claude");
