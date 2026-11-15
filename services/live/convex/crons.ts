import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("prune live feed", { hours: 1 }, internal.live.prune, {});
export default crons;
