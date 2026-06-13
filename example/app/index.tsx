// TEMP (visual-match demo): boot straight into the mood-context reproduction
// so it's trivial to reach for the ennio_match_screen loop. Remove to restore
// the normal tabs entry.
import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/gauntlet/mood-context" />;
}
