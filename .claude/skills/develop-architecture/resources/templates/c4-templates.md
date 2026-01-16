# C4 Model Templates

## Level 1: System Context

**Purpose:** Show system in scope and external dependencies
**Audience:** Technical and non-technical stakeholders

```plantuml
@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Context.puml

LAYOUT_WITH_LEGEND()

title System Context Diagram for [System Name]

Person(user, "User", "End user of the system")
System(system, "[System Name]", "Description of what the system does")
System_Ext(external1, "[External System]", "Description")
System_Ext(external2, "[External System]", "Description")

Rel(user, system, "Uses", "HTTPS")
Rel(system, external1, "Reads from", "REST/HTTP")
Rel(system, external2, "Sends to", "AMQP")

@enduml
```

## Level 2: Container

**Purpose:** Show deployable units (web app, API, database, message queue)
**Audience:** Technical stakeholders, architects

```plantuml
@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml

LAYOUT_WITH_LEGEND()

title Container Diagram for [System Name]

Person(user, "User")

System_Boundary(system, "[System Name]") {
    Container(web, "Web Application", "React", "Delivers UI to browser")
    Container(api, "API Application", "Node.js", "Provides business logic via REST")
    ContainerDb(db, "Database", "PostgreSQL", "Stores data")
    Container(queue, "Message Queue", "RabbitMQ", "Async processing")
}

System_Ext(external, "[External System]")

Rel(user, web, "Uses", "HTTPS")
Rel(web, api, "Calls", "REST/HTTPS")
Rel(api, db, "Reads/Writes", "JDBC/TLS")
Rel(api, queue, "Publishes", "AMQP")
Rel(api, external, "Integrates", "REST/HTTPS")

@enduml
```

## Level 3: Component

**Purpose:** Show internal components within containers
**Audience:** Developers, architects

```plantuml
@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Component.puml

LAYOUT_WITH_LEGEND()

title Component Diagram for [Container Name]

Container_Boundary(api, "API Application") {
    Component(controller, "UserController", "Controller", "Handles HTTP requests")
    Component(service, "UserService", "Service", "Business logic")
    Component(repository, "UserRepository", "Repository", "Data access")
}

ContainerDb(db, "Database", "PostgreSQL")

Rel(controller, service, "Uses")
Rel(service, repository, "Uses")
Rel(repository, db, "Reads/Writes", "JDBC")

@enduml
```

## Supplementary: Deployment Diagram

```plantuml
@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Deployment.puml

title Deployment Diagram for [System Name]

Deployment_Node(aws, "AWS", "Cloud Provider") {
    Deployment_Node(vpc, "VPC", "Virtual Private Cloud") {
        Deployment_Node(ecs, "ECS Cluster") {
            Container(api, "API", "Node.js")
        }
        Deployment_Node(rds, "RDS") {
            ContainerDb(db, "Database", "PostgreSQL")
        }
    }
}

Rel(api, db, "Connects", "TLS")

@enduml
```

## Notation Guidelines

**System/Container/Component:**
- Use boxes with labels
- Include technology stack
- Show relationships with labeled arrows

**Relationships:**
- Label with interaction type (uses, reads, sends)
- Include protocol (HTTPS, JDBC, AMQP)

**External Systems:**
- Use dashed borders or different color
- Label clearly as external

## Tools

- **PlantUML:** Text-based, version-controllable
- **Draw.io:** Visual editor, export to SVG/PNG
- **Structurizr:** C4-specific tool with DSL
