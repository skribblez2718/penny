// Joern data flow query — SQL Injection
//
// Detects: data flow from user input to SQL query construction
//          (works for both server-side Node.js and any client-side SQL.js)

importCpg("$CPG_PATH")

val source = cpg.call.name("""
  req\.(body|query|params)|
  location\.search|
  postMessage
""")

val sink = cpg.call.name("""
  \.query\(|\.execute\(|\.run\(|\.raw\(|
  knex\(|sequelize\.|
  mysql\.|pg\.|sqlite\.|better-sqlite3
""")

sink.reachableByFlows(source).toJson
