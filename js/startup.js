/* Classic script: this recovery UI must work even when ES modules cannot load. */
function startMarsAtlas(loadApplication) {
  var get = function (id) {
    return document.getElementById(id);
  };
  var panel = get("loading");
  var retry = get("retry");
  var timer;
  var finished = false;

  retry.onclick = function () {
    location.reload();
  };

  function fail(title, message, error) {
    panel.hidden = false;
    panel.classList.add("startup-error");
    panel.setAttribute("role", "alert");
    get("loading-spinner").hidden = true;
    get("loading-title").textContent = title;
    get("loading-message").textContent = message;
    get("startup-help").hidden = false;
    retry.hidden = false;
    if (error) {
      get("startup-details").hidden = false;
      get("startup-error-details").textContent = String(error.message || error);
    }
  }

  if (location.protocol === "file:") {
    fail(
      "Open Mars Atlas with its launcher",
      "Opening index.html directly cannot load the terrain. Use the launcher below to open the app at a local web address.",
    );
    retry.hidden = true;
    return Promise.resolve(false);
  }

  function onError(event) {
    if (!finished && event.message) {
      fail(
        "Unable to start the explorer",
        "The app could not start in this browser. Try the launcher below, or share the error details with your group.",
        event.error || event.message,
      );
    }
  }
  window.addEventListener("error", onError);
  timer = setTimeout(function () {
    fail(
      "The explorer is taking too long to start",
      "Check that the project is running and all its files are available, then try again. The launcher below starts the app for you.",
    );
  }, 30000);

  function finish() {
    finished = true;
    clearTimeout(timer);
    window.removeEventListener("error", onError);
  }

  return Promise.resolve()
    .then(loadApplication)
    .then(function (application) {
      if (typeof application.init !== "function") {
        throw new Error(
          "The app entry point is missing. Update the entire project folder from the same branch.",
        );
      }
      return application.init();
    })
    .then(function () {
      finish();
      return true;
    })
    .catch(function (error) {
      finish();
      fail(
        "Unable to load the app files",
        "The browser could not load the explorer. Open the complete project with its launcher, or check that your web server serves JavaScript files correctly.",
        error,
      );
      return false;
    });
}
