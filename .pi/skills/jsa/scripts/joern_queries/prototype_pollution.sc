// Joern data flow query — Prototype Pollution
//
// Detects: data flow from user input to Object.assign, spread, merge, extend
//          operations on objects (which can pollute Object.prototype)

importCpg("$CPG_PATH")

val source = cpg.call.name("""
  \.parse\(|
  req\.(body|query|params)|
  location\.search|
  postMessage
""")

val sink = cpg.call.name("""
  Object\.assign|
  \.extend\(|
  \.merge\(|
  __proto__|
  \.\.\.
""")

sink.reachableByFlows(source).toJson
