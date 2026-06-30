# Resume Accomplishments — Kristoffer Sketch

> **Extracted from:** 21 performance evaluations spanning 2019–2025 at Asurion
> **Format:** STAR (Situation, Task, Action, Result) where supported by review data
> **Confidence:** All facts sourced directly from manager and self-evaluations. Some Situation/Task inferred from context where clearly implied by the Action/Result.
> **Quantification:** Drawn from reviews + supplemental context provided 2026-05-14
> **Role progression:** Application Penetration Tester 2 (2019) → Tester 3 (2020) → Tester 4 (2023)
> **Rating highlights:** Exceeds Performance (top-tier, 2024); Strong Performance (2025)

---

## How to Use This File

Bullets are organized into **8 competency sections** so you can plug-and-play based on the job posting:

| Job target | Pull from sections |
|------------|-------------------|
| AppSec / Pentesting / Offensive Security | 1, 3, 7 |
| AI Security / ML Security Engineer | 2, 3, 8 |
| DevSecOps / Security Engineering | 3, 4, 6 |
| Staff / Principal / Senior IC | 4, 5, 8 |
| Red Team / Adversary Simulation | 7, 6, 3 |
| Cloud Security | 6, 1, 3 |
| Team Lead / Management Track | 5, 4, 8 |

Each bullet is self-contained — copy directly into a resume. Reorder within sections for emphasis.

---

## 1. Penetration Testing & Vulnerability Discovery

*Performed 110+ penetration tests across web applications, APIs, cloud environments, and microservice architectures over 6 years — adapting testing methodologies to common stacks (React, Node.js, traditional databases) and less common technologies (graph databases, non-relational data stores) alike. Consistently identified critical vulnerabilities missed by prior assessments, including findings overlooked by internal penetration tests, third-party firm tests, and engineering code reviews. (2019–2025)*

*Validated and reproduced complex, non-trivial vulnerabilities to assess real-world exploitability — developing proof-of-concept exploits under tight technical constraints including character-limited injection payloads requiring deep research into undocumented database behavior, authentication bypass chains dependent on application load order, and deserialization attacks requiring modification of existing exploitation frameworks. Earned CVE-2022-41402 for remote code execution discovery. (2019–2025)*

*Demonstrated ability to rapidly pivot and deliver high-impact findings without formal scoping — initiated an ad hoc penetration test after noticing a misconfiguration while working on an unrelated assessment, discovering critical and high-severity vulnerabilities in a regional application within one week. (2022)*

*Completed large-scale API penetration tests, analyzing 78 endpoints across 10 repositories and identifying critical and high-severity vulnerabilities across complex microservice architectures; uncovered authentication and authorization gaps in GraphQL endpoints resulting in PII disclosure across multiple downstream applications, coordinating cross-team communications to compress remediation timelines from months to days. (2022–2023)*

*Enumerated over 30,000 domains belonging to the organization, identifying 5 potential subdomain takeovers actionable for security campaigns and expanding asset visibility beyond what existing tooling provided. (2025)*

---

## 2. AI/ML Security & Innovation

*Conducted AI security assessments across multiple enterprise AI deployments, researching and operationalizing emerging prompt injection techniques to compromise production AI systems; findings directly informed security hardening of enterprise AI platforms — including content filtering improvements and chat system security controls — and were adopted by AI platform and application development teams. (2024–2025)*

*Deployed and scaled OpenWebUI as an enterprise AI platform, single-handedly onboarding 400+ users across Security, Legal, Procurement, HR, Finance, Fraud, and other departments without external support. Created 170 specialized AI assistants tailored to departmental needs with 120+ access groups for data controls; integrated multiple AI models and developed comprehensive training materials including 5 video tutorials. Delivered hands-on AI enablement that users described as more practical than formal training, achieving 50% adoption across highest-usage departments. The self-hosted architecture keeps all data local for security and compliance while saving over $1M annually compared to commercial AI subscriptions at an annualized platform cost of ~$20,544. Deployed 672 cloud resources across a multi-region disaster recovery configuration with 16,022 lines of infrastructure code — work typically scoped for a team of 2–3 engineers. Recognized with a $2,000 spot bonus. (2024–2025)*

*Created Bonfire, an open-source automated prompt injection testing tool that generates adversarial AI payloads across text, audio, and image modalities, analyzes results, and produces structured reports. Experimented with AI-enhanced security research by scraping and contextualizing data from Portswigger Web Academy, Hack Tricks, and OWASP to create hacking-specific AI models — a method that also simulates small language model behavior for security applications on large projects. (2024–2025)*

*Completed Stanford University's Supervised Machine Learning: Regression and Classification course and multiple AI security certifications including Red Blue Purple AI (4 iterations) and Attacking AI (3 iterations) from Arcanum Security, immediately applying knowledge to develop security-focused AI assistants and testing tools. Researched and shared methodology for deploying cost-effective GPU-optimized cloud instances for local AI model execution with automated shutdown tagging, and shared architecture for locally-hosted AI addressing privacy and security concerns of public model usage. (2024–2025)*

---

## 3. Tool Development & Automation

*Created and distributed custom security testing tools that accelerated penetration test workflows — including a cloud API request signing tool (AmaZign) designed for CI/CD pipeline integration, and a Burp Suite export parser (Parseley) that converts proxy history to asset upload format, saving the pentest team hours of manual data entry per test and benefiting both Penetration Testing and Security Engineering teams. (2019–2025)*

*Created Bonfire, an open-source automated prompt injection testing tool that generates adversarial AI payloads, analyzes results, and produces detailed reports. Built custom AI assistants for generating PDF and Office documents with preview capabilities, browser-based Markdown converters, and meta-prompters enabling non-technical users to build their own specialized AI assistants without prompt engineering expertise — democratizing AI tool creation across departments. (2024–2025)*

*Wrote a full Red Team exploitation toolchain for an operational campaign: browser extensions (Chrome, Firefox, Edge), HTML phishing email templates, VBA exploit payloads with organization-owned-computer verification, Python automation scripts (cookie capture, code-to-string conversion), JavaScript obfuscation programs for defense evasion, and an API to exfiltrate user session values for real-time monitoring. Automated deployment of redirectors and isolated infrastructure, architecting data flow to ensure all exfiltrated data remained on organization-owned assets. (2024)*

*Built modern web applications containing deliberately planted authentication bypass and multi-stage exploit chain vulnerabilities, deployed in cloud sandboxes for training exercises — providing the security team with black-box testing practice and enabling white-box code analysis training for junior testers. (2022–2025)*

---

## 4. Process Improvement & Standards Development

*Established repeatable assessment methodologies adopted across the penetration testing and security engineering teams — developing 12 vulnerability finding templates covering classes including injection, broken authentication, SSRF, MFA bypass, path traversal, and cloud misconfigurations; added exploit templates for CSRF, CORS, clickjacking, and websockets to reduce time-to-exploit for common vulnerability classes; introduced the OWASP Risk Management Framework as a standardized methodology for risk-aligned vulnerability assessment. (2020–2023)*

*Created a comprehensive report writing standard to standardize deliverables across penetration testing and security engineering teams, enabling cross-team validation of finding remediations and reducing report variability. Redesigned the penetration test intake process with domain and platform tagging to identify application owners, improving finding assignment accuracy and accountability. Established a recurring meeting structure for penetration test readouts with Product Security, creating consistent communication cadence between testers and stakeholders. (2023–2025)*

*Identified contradictions between internal security recommendations and existing organizational policies, initiating discussions that paved the way for policy alignment. Collaborated with the cloud governance team to address gaps in auditing container security, enabling proper oversight and compliance. Partnered with the Risk team to establish risk-level classifications for vulnerabilities that could not be remediated within SLA timeframes. (2020–2024)*

---

## 5. Mentorship, Training & Team Leadership

*Mentored junior penetration testers, interns, and part-time security practitioners from other departments through complete penetration test lifecycles — from reconnaissance through exploitation to report writing — using hands-on, guided approaches that accelerated development from zero experience to independent contributor. Coached team members on specialized topics including cloud identity exploitation, GraphQL testing, and OAuth security, transferring deep technical knowledge across the team. Oriented and mentored 3 new hires, providing access to team documentation, cloud resources, and ongoing guidance to help them navigate complex application environments. (2020–2025)*

*Designed and implemented an innovative candidate evaluation process using realistic vulnerable web applications instead of traditional interview questions, resulting in the hiring of 3 high-quality penetration testers who were immediately productive upon onboarding. Completed Asurion A-Team Ambassador Training and served as a trusted expert consulted by team members across the security organization. (2022–2025)*

*Delivered live security training to 50+ employees across the organization, demonstrating the end-to-end penetration testing process and growing security awareness and testing literacy. Created and distributed CTF machines and research exercises for team training, designing vulnerable scenarios and technical investigations that promoted critical thinking and deep exploitation skills among teammates. (2021–2023)*

---

## 6. Cloud & Infrastructure Security

*Identified systemic cloud identity misconfigurations across applications and advocated for adoption of the company standard identity platform in findings reports and stakeholder discussions, coordinating with APAC leadership to plan expansion across multiple regions with regional PII regulation compliance. Discovered a deprecated OAuth flow used by 389 teams and drove remediation across the organization. Identified and reported a long-standing MFA bypass in a cloud identity provider integration that had been discovered 7 months prior but never remediated, delivering a mitigation plan that worked across organizational boundaries. (2022–2023)*

*Researched and mastered GraphQL security, including direct collaboration with the cloud provider's account team and product group to fully understand the GraphQL attack surface, then applied this knowledge to penetration tests and shared findings across the security organization. Discovered that a cloud API was using weak authentication (4-digit PINs where NIST recommends 6+), raised awareness with the engineering team, and drove the change to production. Identified a capability token access control issue causing multiple production outages with no existing security guidance — independently developed official security documentation and recommended a standardized remediation. (2020–2023)*

*Deployed localized pentesting infrastructure to a dedicated network segment, isolating penetration testing traffic from general corporate network activity and reducing friction with security operations. Implemented cloud security best practices across compute, storage, container, monitoring, DNS, encryption, and build services during enterprise platform deployments, ensuring all logs were consumable by the security operations center. Developed an automated threat intelligence ingestion tool leveraging AI to produce synopses and STIX-compliant bundles for integration with security tools. (2024–2025)*

---

## 7. Red Team Operations

*Designed and executed a complete Red Team campaign, engineering browser extensions (Chrome, Firefox, Edge), HTML phishing email templates, VBA exploit payloads with built-in organization-owned-computer verification, Python automation scripts for credential capture, JavaScript obfuscation programs for defense evasion, and an API for real-time session exfiltration. Stood up full operational infrastructure including redirectors and isolated servers on QubesOS running on an organization-owned machine, automating deployment and architecting data flow to ensure all exfiltrated data remained on organization-owned assets. (2024)*

*Bridged penetration testing findings into operational adversary simulation, creating proof-of-concept exploits and detailed campaign plans for the Red Team to leverage discovered web vulnerabilities — including unvalidated file upload and unvalidated redirect via magic links — to obtain internal network access. Modified ysoserial to craft a reverse shell payload for an Insecure Deserialization vulnerability in a third-party-hosted portal, confirmed exploitation was possible, and verified no sensitive data resided on the compromised server. Discovered a Remote Code Execution vulnerability and exposed internal communication channels via a web application; findings were used in a Red Team operational campaign with CVE publication planned pending remediation. (2022)*

---

## 8. Cross-Functional Collaboration & Business Impact

*Built trust-based relationships with development teams across the organization, becoming sought out organically by departments for security guidance — with development teams often proving more receptive to security change than internal security peers. Provided direct security guidance to Fraud, Legal, HR, Procurement, and Finance teams, applying penetration testing insights to broader organizational risk reduction. Delivered technical documentation and coding examples that enabled development teams to migrate off deprecated authentication systems and adopt secure alternatives. (2020–2025)*

*Delivered hands-on AI enablement to colleagues across the organization, with one user noting the guidance was more practical and effective than formal training. Created and populated a communication channel to share AI tips, tricks, and best practices across all onboarded departments, fostering a community of practice around secure AI usage. Recognized as a subject matter expert in AI security, consulted by senior leaders and cross-functional stakeholders for strategic guidance on AI adoption, standards development, and security architecture decisions. (2024–2025)*

*Collaborated extensively with engineering teams to deliver API specifications and comprehensive security analyses including STRIDE modeling, attack trees, and test cases in support of ISO 27001 compliance. Contributed to the Security Awareness program by developing and delivering presentations translating security concepts for non-technical audiences. (2020–2025)*

---

## Certifications & Continuous Learning

- **OSCP** (Offensive Security Certified Professional) — earned 2021
- **OSWE** (Offensive Security Web Expert) — earned 2021
- **OSEP** (Offensive Security Experienced Penetration Tester) — course completed, exam in progress
- **OSED** (Offensive Security Exploit Development) — 3 modules completed
- **Certified Bug Bounty Hunter** (Hack The Box) — 10 modules completed
- **Red Blue Purple AI** (Arcanum Security / Jason Haddix) — completed 4 iterations
- **Attacking AI** (Arcanum Security) — completed 3 iterations
- **Stanford Machine Learning: Regression and Classification** — 2/3 weeks completed
- **Portswigger Web Academy** — 69% completion (53/53 Apprentice, 106/156 Practitioner, 12/36 Expert)
- **Asurion A-Team Ambassador Training** — completed

---

## Metrics-at-a-Glance

| Metric | Approximate |
|--------|-------------|
| Penetration tests completed (2019–2025) | ~110–120 |
| Vulnerability database entries created | 30+ |
| OpenWebUI users onboarded | 180+ |
| OpenWebUI specialized assistants/models | 170 |
| AWS resources deployed (OpenWebUI) | 672 |
| Infrastructure code written (OpenWebUI) | 16,022 lines |
| OpenWebUI annualized platform cost | ~$20,544 |
| ISO-scoped tests completed on schedule | 100% |
| Candidates hired through new interview process | 3 |
| Peak team size | 5 (average: 3) |
| Spot bonus (OpenWebUI deployment) | $2,000 |

---

*Generated 2026-05-14 from 21 performance evaluations (2019–2025) plus supplemental context.*
*Last updated: 2026-05-19 (restructured: combined individual bullets into cumulative tenure-spanning narratives)*
