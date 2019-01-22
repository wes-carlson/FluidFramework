const profane_words = [
    "belichick",
    "boston",
    "brady",
    "bruins",
    "celtics",
    "new england",
    "red sox",
    "patriots",
];

const profanExp = new RegExp(profane_words.join("|"), "g");
let cheating = false;

export function filter(input: string): string {
    if (!cheating) {
        return input.replace(profanExp, (match: string, matchStart: number, matchedPhrase: string ) => {

            let cleaned = match.slice(0, 1);
            cleaned += "*".repeat(match.length - 2);
            cleaned += match.slice(match.length - 1, match.length);
            return cleaned;
        });
    }
    return input;
}

function cheat() {
    cheating = !cheating;
    if (cheating) {
        console.log("You cheater");
    } else {
        console.log("Thanks!")
    }
}

(window as any).cheat = cheat;
