import click


@click.command()
def main() -> None:
    click.echo("hello")


if __name__ == "__main__":
    main()
