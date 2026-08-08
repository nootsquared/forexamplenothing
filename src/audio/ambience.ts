import { audio } from './engine';

// The ground before anybody kicks a ball. A title screen that makes no sound
// at all does not read as restraint, it reads as broken audio — so the menus
// stand in the same stadium the match does, held back to a murmur, with a bird
// over the empty terrace every so often. MatchAudio takes the same two beds
// over the instant a match begins; only the birds belong to this file.

export const BIRDS = ['bird-a', 'bird-b', 'bird-c', 'bird-d'];

const MENU_BED = 0.42; // a ground filling up, not a ground watching football

class FrontOfHouse {
  private birdT = 4;

  open() {
    audio.ambient('crowd-bed', true, 2.5, MENU_BED);
    audio.ambient('wind', true, 3);
    this.birdT = 3 + Math.random() * 5;
  }

  // Only ticks while a menu is actually on screen, so the match's own birdsong
  // never doubles up with this one
  update(dt: number) {
    this.birdT -= dt;
    if (this.birdT > 0) return;
    this.birdT = 7 + Math.random() * 11;
    audio.play(BIRDS[Math.floor(Math.random() * BIRDS.length)], { pan: Math.random() * 1.4 - 0.7, jitter: 0.12 });
  }
}

export const frontOfHouse = new FrontOfHouse();
