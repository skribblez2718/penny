// Joern data flow query — SSRF
//
// Detects: data flow from user input to fetch/axios/http request functions
//          where the URL is attacker-controlled (can pivot to internal services)

importCpg("$CPG_PATH")

val source = cpg.call.name("""
  req\.(body|query|params)|
  location\.search|
  postMessage|
  document\.URL
""")

val sink = cpg.call.name("""
  fetch\(|axios\(|\.get\(|\.post\(|\.put\(|\.delete\(|
  http\.get\(|https\.get\(|http\.request\(|https\.request\(|
  request\(
""")

sink.reachableByFlows(source).toJson
