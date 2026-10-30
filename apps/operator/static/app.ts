/** Renders projected run state and sends the Runboard's allowlisted control requests. */
import { loadProjects, showRunsUnavailable, startCataloguePolling } from "./js/data.js";
import { bindHandlers } from "./js/handlers.js";
import { bindThemeToggle } from "./js/theme.js";
import { bindWorkflowEditor } from "./js/workflows.js";

bindHandlers();
bindWorkflowEditor();
bindThemeToggle();

loadProjects().then(startCataloguePolling).catch(showRunsUnavailable);
