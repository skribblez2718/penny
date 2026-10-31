import process from "node:process";
// Isolated Linux identity fixture. No GPU, service, model, network, or external work.
process.on("message", (message) => {
  if (message === "exit") process.exit(0);
});
process.send({ ready: true });
