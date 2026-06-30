// Joern data flow query — Command Injection
//
// Detects: data flow from user input to eval, exec, Function constructor,
//          setTimeout/setInterval with string argument

importCpg("$CPG_PATH")

val source = cpg.call.name("""
  req\.(body|query|params)|
  location\.search|
  postMessage|
  document\.URL
""")

val sink = cpg.call.name("""
  eval\(|
  exec\(|execSync\(|spawn\(|spawnSync\(|
  new\s+Function\(
""")

// setTimeout/setInterval with string arg is also dangerous
val timerSink = cpg.call.name("setTimeout|setInterval")
  .where(_.argument(0).code(".*[\"'].*[\"'].*"))

sink.reachableByFlows(source).toJson
