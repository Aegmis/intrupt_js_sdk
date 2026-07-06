// Preload environment variables from .env, overriding any stale values already
// present in the shell so .env is the single source of truth. Imported as a
// side effect BEFORE any module that reads process.env at import time.
import dotenv from "dotenv";

dotenv.config({ override: true });
