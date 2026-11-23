// Every /api/... request goes to the app's server code.
import { handle } from "../../server/api.js";

export const onRequest = ({ request, env }) => handle(request, env);
