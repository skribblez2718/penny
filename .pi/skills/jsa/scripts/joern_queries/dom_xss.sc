// Joern data flow query — DOM XSS
//
// Detects: data flow from user-controlled sources (location.*, document.URL,
//          postMessage event.data) to dangerous sinks (.innerHTML, eval, etc.)
//
// Usage:
//   joern --script dom_xss.sc
//   (with $CPG_PATH set in the script before execution)

importCpg("$CPG_PATH")

// Sources: user-controlled data
val source = cpg.call.name("""
  location\..*|
  document\.URL|
  document\.location|
  document\.referrer|
  window\.name|
  document\.cookie|
  URLSearchParams.*|
  postMessage
""")

// Sinks: dangerous DOM operations
val sink = cpg.call.name("""
  .*innerHTML|
  .*outerHTML|
  .*insertAdjacentHTML|
  document\.write|
  .*\.html\(|
  eval|
  new\s+Function
""")

// Find flows from sources to sinks
sink.reachableByFlows(source).toJson
