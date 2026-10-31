// Source-level NestJS-style oracle; locally declared decorators, no dependency.
function Controller(_path: string): ClassDecorator {
  void _path;
  return () => {};
}
function Get(_path: string) {
  void _path;
  return (_value: (value: string) => string, _context: ClassMethodDecoratorContext): void => {
    void _value;
    void _context;
  };
}
function persistRecord(value: string): string {
  return value;
}
function persistDecoy(value: string): string {
  return value;
}
@Controller("records")
class RecordController {
  @Get("one")
  handleRecord(inputValue: string): string {
    const assignedValue = inputValue;
    if (assignedValue !== "") {
      const guardedAction = assignedValue;
      const sinkValue = guardedAction;
      return persistRecord(sinkValue);
    } else {
      return persistDecoy("unrelated");
    }
  }
  @Get("decoy")
  decoyHandler(decoyValue: string): string {
    return decoyValue;
  }
}
void RecordController;
