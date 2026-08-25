import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { generate, validate_pptx } from "../../renderer.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const target of cleanup.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function writeMutatedPackage(
  base: Buffer,
  output: string,
  mutate: (zip: JSZip) => Promise<void> | void
): Promise<void> {
  const zip = await JSZip.loadAsync(base, { checkCRC32: true });
  await mutate(zip);
  fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer" }));
}

describe("internal PPTX XML boundaries", () => {
  it("accepts valid/open XML nodes and rejects missing or wrong required node shapes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-pptx-xml-boundary-"));
    cleanup.push(directory);
    const source = path.join(directory, "source.pptx");
    await generate({
      output_path: source,
      project_root: directory,
      slides: [{ layout: "title", title: "XML Boundary" }],
    });
    const base = fs.readFileSync(source);
    await expect(validate_pptx(source, 1)).resolves.toMatchObject({ slide_count: 1 });

    const withExtras = path.join(directory, "xml-extras.pptx");
    await writeMutatedPackage(base, withExtras, async (zip) => {
      const part = zip.file("ppt/_rels/presentation.xml.rels");
      if (!part) throw new Error("fixture is missing presentation relationships");
      const xml = await part.async("string");
      zip.file(
        "ppt/_rels/presentation.xml.rels",
        xml
          .replace("<Relationships ", '<Relationships futureRootAttribute="retained" ')
          .replace("<Relationship ", '<Relationship futureNodeAttribute="retained" ')
      );
    });
    await expect(validate_pptx(withExtras, 1)).resolves.toMatchObject({ slide_count: 1 });

    const missingRelationships = path.join(directory, "missing-relationships-root.pptx");
    await writeMutatedPackage(base, missingRelationships, (zip) => {
      zip.file("ppt/_rels/presentation.xml.rels", '<?xml version="1.0"?><WrongRoot/>');
    });
    await expect(validate_pptx(missingRelationships, 1)).rejects.toThrow(
      /malformed relationships part/i
    );

    const wrongRelationship = path.join(directory, "wrong-relationship-node.pptx");
    await writeMutatedPackage(base, wrongRelationship, (zip) => {
      zip.file(
        "ppt/_rels/presentation.xml.rels",
        '<?xml version="1.0"?><Relationships><Relationship>wrong</Relationship></Relationships>'
      );
    });
    await expect(validate_pptx(wrongRelationship, 1)).rejects.toThrow(
      /malformed relationships part/i
    );

    const missingPresentation = path.join(directory, "missing-presentation-root.pptx");
    await writeMutatedPackage(base, missingPresentation, (zip) => {
      zip.file("ppt/presentation.xml", '<?xml version="1.0"?><WrongRoot/>');
    });
    await expect(validate_pptx(missingPresentation, 1)).rejects.toThrow(
      /presentation XML root p:presentation must be an XML object/i
    );

    const wrongSlideList = path.join(directory, "wrong-slide-list.pptx");
    await writeMutatedPackage(base, wrongSlideList, (zip) => {
      zip.file(
        "ppt/presentation.xml",
        '<?xml version="1.0"?><p:presentation xmlns:p="urn:p"><p:sldIdLst>wrong</p:sldIdLst></p:presentation>'
      );
    });
    await expect(validate_pptx(wrongSlideList, 1)).rejects.toThrow(
      /presentation slide-id list p:sldIdLst must be an XML object/i
    );
  });
});
