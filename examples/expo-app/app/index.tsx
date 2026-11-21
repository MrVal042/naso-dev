import { Text } from 'react-native';
import { formatDate } from '@/lib/date';

export default function Home() {
  return <Text>{formatDate(new Date())}</Text>;
}
