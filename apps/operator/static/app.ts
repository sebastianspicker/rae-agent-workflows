/** Renders projected run state and sends the Runboard's allowlisted control requests. */
import { setConnection, showError } from "./js/api.js";
import { loadProjects, startCataloguePolling } from "./js/data.js";
import { bindHandlers } from "./js/handlers.js";
import { bindThemeToggle } from "./js/theme.js";
import { bindWorkflowEditor } from "./js/workflows.js";
import { elements } from "./js/state.js";

bindHandlers();
bindWorkflowEditor();
bindThemeToggle();

loadProjects()
  .then(startCataloguePolling)
  .catch((error) => {
    setConnection("error", "Unavailable", "Local session");
    elements["runs-loading"].hidden = true;
    elements["workspace-empty"].hidden = true;
    elements["runs-empty"].hidden = false;
    elements["runs-empty"].querySelector("strong")!.textContent = "Runs unavailable";
    elements["runs-empty"].querySelector("span")!.textContent =
      "Reopen the URL printed by the operator server.";
    showError(error);
  });
